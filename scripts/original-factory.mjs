import ts from 'typescript';

/** Extract the published factory verbatim; never execute the loader wrapper. */
export function parseFactory(source, packageName) {
  const ast = ts.createSourceFile(`${packageName}.js`, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let factory;
  let registrations = 0;
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'window.__ModuleLoader__.load') {
      registrations += 1;
      const argument = node.arguments[0];
      if (!argument || !ts.isObjectLiteralExpression(argument)) throw new Error(`${packageName}: expected a literal module registration`);
      const property = argument.properties.find(item => ts.isPropertyAssignment(item) && item.name.getText(ast) === 'factory');
      factory = property && property.initializer;
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  if (registrations !== 1 || !factory || !(ts.isArrowFunction(factory) || ts.isFunctionExpression(factory))) {
    throw new Error(`${packageName}: expected exactly one published client factory`);
  }
  const requireName = factory.parameters[0]?.name.getText(ast);
  const requires = new Set();
  function references(node) {
    if (node !== factory && ts.isFunctionLike(node)) {
      if (node.parameters?.some(parameter => parameter.name.getText(ast) === requireName)) return;
      if (node.name?.getText(ast) === requireName) return;
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
      && node.expression.text === requireName && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
      requires.add(node.arguments[0].text);
    }
    ts.forEachChild(node, references);
  }
  if (requireName) references(factory);
  return { factory: factory.getText(ast), requires: [...requires].sort() };
}
