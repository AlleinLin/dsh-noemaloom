import ts from 'typescript';
import path from 'node:path';
import { builtinModules } from 'node:module';
import { sha256 } from './shared.js';

export interface RuleDefinition {
  ruleId: string; language: string; topic: string; severityDefault: 'error' | 'warning';
  summary: string; detector: 'syntax' | 'type-aware' | 'manual-semantic' | 'external';
  fixSafety: 'safe' | 'behavioral' | 'none'; exceptions: string[]; knownGaps: string[];
  sourceRef: string;
}
const rule = (id: string, summary: string, severity: 'error' | 'warning' = 'error', detector: RuleDefinition['detector'] = 'syntax', fixSafety: RuleDefinition['fixSafety'] = 'none', exceptions: string[] = []): RuleDefinition => ({
  ruleId: `hlt.${id}`, language: id.split('.')[0]!, topic: id.slice(id.indexOf('.') + 1), severityDefault: severity,
  summary, detector, fixSafety, exceptions,
  knownGaps: detector === 'manual-semantic' ? ['需要有限范围独立语义审阅，静态候选不是跨过程证明'] : detector === 'type-aware' ? ['必须由真实项目 type service 执行'] : [],
  sourceRef: `methods/how-to-lint/references/${id.startsWith('py.') ? 'python' : id.startsWith('go.') ? 'go' : id.startsWith('error.') || id.startsWith('config.') ? 'error-handling' : 'typescript'}.md`,
});

export const RULES: RuleDefinition[] = [
  rule('ts.eqeqeq', '严格相等，禁止隐式类型转换比较'),
  rule('ts.no-var', '使用 let/const 替代 var', 'error', 'syntax', 'none'),
  rule('ts.prefer-const', '不重新赋值的绑定优先 const', 'error', 'type-aware'),
  rule('ts.no-debugger', '不保留 debugger 断点', 'error', 'syntax', 'safe'),
  rule('ts.curly', '分支和循环体使用花括号'),
  rule('ts.function-expression', '普通函数优先表达式', 'error', 'syntax', 'behavioral', ['方法、overload、ambient 和框架声明形式']),
  rule('ts.function-max-statements', '每个函数最多 30 条语句，按 AST 语句计数'),
  rule('ts.filename-kebab-case', '手写文件名 kebab-case', 'error', 'syntax', 'none', ['框架路由、组件、约定文件与生成代码']),
  rule('ts.type-imports', '类型导入与值导入分开', 'error', 'type-aware', 'none', ['装饰器运行时 metadata']),
  rule('ts.no-namespace', '避免 namespace', 'error', 'syntax', 'none', ['声明文件与模块扩展']),
  rule('ts.internal-no-null', '内部缺省值优先 undefined', 'error', 'manual-semantic', 'behavioral', ['外部 API、数据库、DOM、框架协议']),
  rule('ts.node-protocol', 'Node 内置模块导入使用 node:', 'error', 'syntax', 'safe'),
  rule('ts.no-duplicate-import', '同源导入去重，保留 type/value 语义'),
  rule('ts.no-self-import', '禁止解析后自身导入', 'error', 'type-aware'),
  rule('ts.date-now', '获取当前毫秒使用 Date.now()', 'error', 'syntax', 'safe'),
  rule('ts.array-type', '简单数组类型优先 T[]', 'warning', 'syntax', 'none'),
  rule('ts.expect-error-reason', '抑制类型错误使用有具体原因的 ts-expect-error', 'warning'),
  rule('ts.no-explicit-any', '显式 any 应在必要边界给出局部理由', 'warning'),
  rule('ts.no-floating-promises', 'Promise 必须有拒绝接收方，void 不能证明已处理', 'error', 'type-aware'),
  rule('ts.no-misused-promises', '同步契约位置不误用 Promise', 'error', 'type-aware'),
  rule('ts.strict-compiler', 'strict/noUncheckedIndexedAccess/noImplicitReturns/noFallthroughCasesInSwitch', 'error', 'external'),
  rule('vue.template-types', 'Vue script/setup/template 与 props/emits 均需真实类型检查', 'error', 'external'),
  rule('vue.nuxt-alias', '按真实 Nuxt 版本、root/source 与生成类型解析 alias', 'error', 'external'),
  rule('error.empty-handler', 'catch 不得吞错，注释、void 和嵌套未执行函数不是处理'),
  rule('error.catch-rethrow', '无意义 catch-rethrow 应消除'),
  rule('error.cause-loss', '转换异常必须保留原 cause', 'error', 'manual-semantic'),
  rule('error.false-success', '未知异常不能伪装成功', 'error', 'manual-semantic'),
  rule('error.secret-logging', '日志不能泄露凭据和私有配置', 'error', 'manual-semantic'),
  rule('config.direct-env', '环境读取应集中到有 runtime validation 的明确配置边界', 'error', 'syntax', 'behavioral', ['build/start/test/config 入口']),
  rule('config.private-client', '私有配置不进入 client/SSR public payload', 'error', 'manual-semantic'),
  rule('py.mypy-baseline', '非 strict + check_untyped_defs，保留具体模块缺 stub 说明', 'error', 'external'),
  rule('py.exception-propagation', 'except 保留 cause；取消、中断与 SystemExit 不吞为成功', 'error', 'external'),
  rule('go.error-receiver', 'error 返回和 goroutine 失败需要真实接收方', 'error', 'external'),
  rule('go.vet', 'go vet 与 gofmt 按项目 module/workspace 执行', 'error', 'external'),
  rule('go.env-boundary', '基于 go/types 识别 os alias/shadow 与配置边界', 'error', 'external'),
];

export interface TextEdit { start: number; end: number; text: string }
export interface Diagnostic {
  occurrenceId: string; fingerprint: string; ruleId: string; detectorRef: string;
  severity: 'error' | 'warning'; messageCode: string; message: string; path: string;
  range: { startLine: number; startColumn: number; endLine: number; endColumn: number; unit: 'utf16' };
  sourceHash: string; anchor: string; state: 'confirmed' | 'needs-review'; fixability: string; edit?: TextEdit;
}

export function scanTypeScript(filename: string, text: string, selected?: Set<string>): { diagnostics: Diagnostic[]; unknown: string[] } {
  const kind = filename.endsWith('.tsx') ? ts.ScriptKind.TSX : /\.[cm]?jsx?$/.test(filename) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true, kind);
  const diagnostics: Diagnostic[] = [];
  const hash = sha256(Buffer.from(text));
  const occurrences = new Map<string, number>();
  const add = (id: string, node: ts.Node, message?: string, edit?: TextEdit, state: Diagnostic['state'] = 'confirmed'): void => {
    const definition = RULES.find(item => item.ruleId === id)!;
    if (!definition || (selected && !selected.has(id))) return;
    const anchor = node.getText(source).replace(/\s+/g, ' ').slice(0, 512);
    const logical = sha256({ rule: id, path: filename, anchor });
    const occurrence = occurrences.get(logical) ?? 0;
    occurrences.set(logical, occurrence + 1);
    const start = source.getLineAndCharacterOfPosition(node.getStart(source));
    const end = source.getLineAndCharacterOfPosition(node.getEnd());
    diagnostics.push({
      occurrenceId: sha256({ logical, occurrence, hash, offset: node.getStart(source) }),
      fingerprint: sha256({ logical, occurrence }), ruleId: id, detectorRef: `nexus-ts-ast/${ts.version}`,
      severity: definition.severityDefault, messageCode: id, message: message ?? definition.summary, path: filename,
      range: { startLine: start.line + 1, startColumn: start.character + 1, endLine: end.line + 1, endColumn: end.character + 1, unit: 'utf16' },
      sourceHash: hash, anchor, state, fixability: edit ? 'safe' : definition.fixSafety, ...(edit ? { edit } : {}),
    });
  };
  const isFunction = (node: ts.Node): node is ts.FunctionLikeDeclaration => ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node);
  const countStatements = (node: ts.Node): number => {
    let count = 0;
    const visit = (child: ts.Node): void => {
      if (isFunction(child) && child !== node) return;
      if (ts.isStatement(child) && !ts.isBlock(child) && !ts.isEmptyStatement(child)) count++;
      ts.forEachChild(child, visit);
    };
    ts.forEachChild(node, visit);
    return count;
  };
  const imports = new Map<string, ts.ImportDeclaration>();
  const builtins = new Set(builtinModules.filter(name => !name.startsWith('node:')));
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken || node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken)) add('hlt.ts.eqeqeq', node);
    if (ts.isVariableDeclarationList(node) && !(node.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const))) add('hlt.ts.no-var', node);
    if (ts.isDebuggerStatement(node)) add('hlt.ts.no-debugger', node, undefined, { start: node.getStart(source), end: node.end, text: '' });
    if (ts.isIfStatement(node)) {
      if (!ts.isBlock(node.thenStatement)) add('hlt.ts.curly', node.thenStatement);
      if (node.elseStatement && !ts.isBlock(node.elseStatement) && !ts.isIfStatement(node.elseStatement)) add('hlt.ts.curly', node.elseStatement);
    }
    if ((ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)) && !ts.isBlock(node.statement)) add('hlt.ts.curly', node.statement);
    if (isFunction(node) && node.body && countStatements(node.body) > 30) add('hlt.ts.function-max-statements', node, `函数有 ${countStatements(node.body)} 条语句，上限为 30；不是行数`);
    if (ts.isFunctionDeclaration(node) && node.body && !node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DeclareKeyword || modifier.kind === ts.SyntaxKind.DefaultKeyword) && !source.statements.some(statement => ts.isFunctionDeclaration(statement) && !statement.body && statement.name?.text === node.name?.text)) add('hlt.ts.function-expression', node, undefined, undefined, 'needs-review');
    if (node.kind === ts.SyntaxKind.AnyKeyword) add('hlt.ts.no-explicit-any', node);
    if (ts.isModuleDeclaration(node) && !filename.endsWith('.d.ts') && !ts.isStringLiteral(node.name) && !(node.flags & ts.NodeFlags.GlobalAugmentation)) add('hlt.ts.no-namespace', node);
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && node.typeName.text === 'Array' && node.typeArguments?.length === 1) add('hlt.ts.array-type', node);
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const imported = node.moduleSpecifier.text;
      if (builtins.has(imported)) add('hlt.ts.node-protocol', node.moduleSpecifier, undefined, { start: node.moduleSpecifier.getStart(source) + 1, end: node.moduleSpecifier.end - 1, text: `node:${imported}` });
      const key = `${node.importClause?.isTypeOnly ? 'type' : 'value'}:${imported}`;
      if (imports.has(key)) add('hlt.ts.no-duplicate-import', node);
      imports.set(key, node);
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'getTime' && ts.isNewExpression(node.expression.expression) && ts.isIdentifier(node.expression.expression.expression) && node.expression.expression.expression.text === 'Date' && !node.expression.expression.arguments?.length && !node.arguments.length) add('hlt.ts.date-now', node, undefined, { start: node.getStart(source), end: node.end, text: 'Date.now()' });
    if (ts.isCatchClause(node)) {
      const meaningful = node.block.statements.filter(statement => !ts.isEmptyStatement(statement) && !ts.isFunctionDeclaration(statement) && !(ts.isExpressionStatement(statement) && ts.isVoidExpression(statement.expression)) && !(ts.isVariableStatement(statement) && statement.declarationList.declarations.every(declaration => !declaration.initializer)));
      if (!meaningful.length) add('hlt.error.empty-handler', node);
      else if (meaningful.length === 1 && ts.isThrowStatement(meaningful[0]!) && node.variableDeclaration && meaningful[0]!.expression?.getText(source) === node.variableDeclaration.name.getText(source)) add('hlt.error.catch-rethrow', node);
      else if (!meaningful.some(statement => ts.isThrowStatement(statement) || ts.isReturnStatement(statement))) {
        // A call named reportFailure or log alone is not proof that the failure was handled.
        add('hlt.error.false-success', node, '处理块没有明确传播/失败返回；调用副作用需要语义复核', undefined, 'needs-review');
      }
    }
    if ((ts.isPropertyAccessExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.expression.getText(source) === 'process' && node.expression.name.text === 'env') || (ts.isElementAccessExpression(node) && node.expression.getText(source) === 'process.env')) {
      if (!/(^|\/)(config|configuration|scripts?|tests?|__tests__)(\/|[.-])|(?:vite|next|nuxt|eslint)\.config\./i.test(filename)) add('hlt.config.direct-env', node, '业务层环境读取候选；验证 process 符号及项目配置边界后处理', undefined, 'needs-review');
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const comment = /\/\/[^\r\n]*@ts-(ignore|expect-error)([^\r\n]*)/g;
  for (const match of text.matchAll(comment)) {
    if (match[1] === 'ignore' || !match[2]!.trim().replace(/^[:\s-]+/, '')) {
      const position = source.getLineAndCharacterOfPosition(match.index!);
      const fake = { ...source, getText: () => match[0], getStart: () => match.index!, getEnd: () => match.index! + match[0].length } as unknown as ts.Node;
      add('hlt.ts.expect-error-reason', fake);
      void position;
    }
  }
  const parseDiagnostics = (source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  const unknown = parseDiagnostics.map(item => `语法 ${item.code}: ${ts.flattenDiagnosticMessageText(item.messageText, '\n')}`);
  const filenameStem = path.basename(filename).replace(/(?:\.d)?\.[^.]+$/, '');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(filenameStem) && !/^[A-Z][A-Za-z0-9]*$/.test(filenameStem) && !/[\[\]()]/.test(filenameStem) && !/\.config\.|\.test\.|\.spec\./.test(filename)) add('hlt.ts.filename-kebab-case', source, undefined, undefined, 'needs-review');
  return { diagnostics, unknown };
}

export function applyEdits(text: string, edits: TextEdit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let boundary = text.length + 1;
  for (const edit of sorted) {
    if (edit.start < 0 || edit.end < edit.start || edit.end > text.length || edit.end > boundary) throw new Error('FIX_OVERLAP');
    text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
    boundary = edit.start;
  }
  return text;
}
