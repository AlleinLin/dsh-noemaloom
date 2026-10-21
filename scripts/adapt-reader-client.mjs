import ts from 'typescript';

/**
 * Kept as ordinary JavaScript so the published Reader factory can retain its
 * own React, Markdown, MCP App, streaming and file-opening implementation.
 * This function is serialized into that factory; it is not run by the build.
 */
export function installNativeReader(ctx, prefs, readerInject) {
  const slots = ctx.slots;
  const native = slots.entriesOfSlot("conversation.chat.node")
    .find((entry) => entry.options.key === "assistant-step");
  if (!native || !native.children?.["conversation.chat.reasoning.body"]
    || !native.children?.["conversation.chat.message.images"]) {
    throw new Error("Native assistant-step contract changed; Reader integration was not installed.");
  }
  const names = new Map(Object.keys(native.children).map((key) => [key, `nexus.reader.assistant/${key}`]));
  const children = Object.fromEntries([...names].map(([key, seat]) => [seat, native.children[key]]));
  children["dsh-better-display.block"] = { kind: "chain", scope: "session" };
  const NativeAssistant = translatedComponent(native, names);
  const activatedAt = Date.now();
  const disposers = [];
  const dispose = () => {
    for (const stop of disposers.splice(0).reverse()) stop();
  };

  function ReadingReasoningBody({ text, running, step, startedAt }) {
    const motion = useMotionAllowed(prefs.getSnapshot()?.motion !== false);
    return react.createElement(ReasoningCard, {
      active: running,
      step,
      motion,
      selected: false,
      onRead: () => {},
    }, react.createElement(ReadingReasoning, {
      text,
      streaming: running,
      liveText: true,
      startedAt,
    }));
  }

  function ReadingProducedFiles({ turn, seq, readerServices }) {
    const snap = react.useSyncExternalStore(prefs.subscribe, () => prefs.getSnapshot(), () => prefs.getSnapshot());
    const produced = turn.data.get("deliverables")?.produced ?? [];
    const paths = [...new Set(produced.filter((item) => typeof item?.path === "string"
      && item.path.trim() && (item.seq === undefined || item.seq <= seq)).map((item) => item.path.trim()))];
    if (!showDeliverablesRow(turn.status, paths)) return null;
    return react.createElement(DeliverablesRow, {
      deliverables: paths,
      openFile: readerServices.openFile,
      revealFile: readerServices.revealFile,
      openMode: deliverableOpenModeOf(snap?.deliverableOpenMode),
    });
  }

  const Assistant = react.memo(function NativeReaderAssistant(props) {
    const { node, groupPart, useTurnData, readerServices } = props;
    const data = node.data;
    const root = react.useRef(null);
    const selected = usePinnedSelection(root);
    const snap = react.useSyncExternalStore(prefs.subscribe, () => prefs.getSnapshot(), () => prefs.getSnapshot());
    const motion = useMotionAllowed(snap?.motion !== false);
    const stream = react.useMemo(() => ({ enabled: motion, activatedAt }), [motion]);
    // Keep the native closing-Turn contract for file mentions. In particular,
    // an earlier assistant step must not borrow a later answer's deliverables.
    const tail = useTurnData("turn-tail");
    const turn = node.location.kind === "turn" || node.location.kind === "step" ? node.location.turn : undefined;
    const owner = react.useMemo(() => {
      if (turn?.status !== "closed" || data.finalNode === undefined) return undefined;
      if (tail?.closing?.finalNode.seq !== data.finalNode.seq) return undefined;
      return { turn, seq: data.finalNode.seq, openFile: readerServices.openFile };
    }, [turn, data.finalNode, tail, readerServices.openFile]);
    const mentions = react.useMemo(() => owner === undefined ? undefined : props.fileMentions(owner),
      [owner, props.fileMentions]);
    const nativeRenderSlot = react.useCallback((key, owner, options) => props.renderSlot(key,
      key === names.get("conversation.chat.reasoning.body") ? { ...owner, step: data.step, startedAt: data.time } : owner,
      options), [props.renderSlot, data.step, data.time]);
    const fragments = [];
    let pending = [];
    let pendingKind;
    let first = 0;
    const flush = () => {
      if (!pending.length) return;
      const blocks = pending;
      pending = [];
      if (pendingKind === "native") {
        // The actual native component retains useDisclosure, useGroupAction,
        // usePresentation, turnProcess, image loading and its future behavior.
        // Suppress its per-fragment stop badge; emit that exactly once below.
        const status = data.status === "interrupted"
          || data.status === "running" && blocks.at(-1) !== data.blocks.at(-1) ? "settled" : data.status;
        fragments.push(react.createElement(NativeAssistant, {
          ...props,
          key: first,
          renderSlot: nativeRenderSlot,
          node: { ...node, data: { ...data, blocks, status } },
        }));
      } else {
        fragments.push(react.createElement("div", {
          key: first,
          className: Reader_module_css_default.answer,
          "data-reader-answer": true,
          "data-reader-key": node.key,
        }, react.createElement(Blocks, {
          blocks,
          streaming: data.status === "running",
          interrupted: data.status === "interrupted",
          startedAt: data.time,
          liveText: true,
          holdFormatting: selected.includes(node.key),
          renderSlotChain: props.renderSlotChain,
          loadImage: readerServices.loadImage,
          fillComposer: readerServices.fillComposer,
          fileMentions: mentions,
        })));
      }
    };
    for (let index = 0; index < data.blocks.length; index++) {
      const block = data.blocks[index];
      if (block.kind === "tool-call") continue;
      if (groupPart === "reasoning" && block.kind !== "reasoning") continue;
      if (groupPart === "response" && block.kind === "reasoning") continue;
      const kind = block.kind === "reasoning" || block.kind === "image" ? "native" : "reader";
      if (pendingKind !== kind) {
        flush();
        pendingKind = kind;
        first = index;
      }
      pending.push(block);
    }
    flush();
    const stopped = data.status === "interrupted"
      && (groupPart === undefined || groupPart === "response"
        || !data.blocks.some((block) => block.kind !== "reasoning" && block.kind !== "tool-call"));
    if (stopped) fragments.push(react.createElement(NativeAssistant, {
      ...props,
      key: "stopped",
      renderSlot: nativeRenderSlot,
      groupPart: undefined,
      node: { ...node, data: { ...data, blocks: [] } },
    }));
    return react.createElement(StreamMotionContext.Provider, { value: stream },
      react.createElement("div", {
        ref: root,
        "data-nexus-chat-display": true,
        "data-reader-glass": frostedGlassOf(snap) || undefined,
      }, fragments));
  });

  try {
    const { component: _component, options, children: _children, inject: nativeInject, ...metadata } = native;
    disposers.push(slots.register({
      ...options,
      ...metadata,
      name: "conversation.chat.node",
      priority: (options.priority ?? 0) - 10,
      children,
      inject: (sessionId) => ({
        ...nativeInject?.(sessionId),
        readerServices: readerInject(sessionId),
      }),
      registrant: "dsh-better-display → native assistant-step",
    }, Assistant));
    for (const [source, target] of names) {
      disposers.push(mirrorOfficialSlot(slots, source, target, "nexus.reader.assistant"));
    }
    disposers.push(slots.register({
      name: names.get("conversation.chat.reasoning.body"),
      priority: -100,
    }, ReadingReasoningBody));
    // Native present/diff cards and assistant actions keep their existing seats.
    // Reader's produced-file chips are a separate native tail contribution.
    disposers.push(slots.inject("conversation.chat.turnTail", () => slots.register({
      name: "conversation.chat.turnTail",
      id: "nexus-reader-produced-files",
      order: 10,
      inject: (sessionId) => ({ readerServices: readerInject(sessionId) }),
    }, ReadingProducedFiles)));
  } catch (error) {
    dispose();
    throw error;
  }
  return dispose;
}

function parsedFactory(factory) {
  const source = `const factory = ${factory};`;
  const ast = ts.createSourceFile('reader-factory.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const initializer = ast.statements[0]?.declarationList?.declarations[0]?.initializer;
  if (!initializer || !ts.isBlock(initializer.body)) throw new Error('Reader factory body changed');
  return { source, ast, body: initializer.body, offset: 'const factory = '.length };
}

function findFunction(body, name) {
  const matches = body.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  if (matches.length !== 1) throw new Error(`Reader ${name} contract changed`);
  return matches[0];
}

function property(object, name) {
  return object.properties.find(node => ts.isPropertyAssignment(node)
    && (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name)) && node.name.text === name);
}

/**
 * Only presentation registration changes. The native Chat remains the sole
 * conversation view, projection, flow, composer, approval and tail owner.
 */
export function adaptReaderClient(factory) {
  const { ast, body, offset } = parsedFactory(factory);
  const apply = findFunction(body, 'apply');
  let readerInject;
  let readerCount = 0;
  function findReader(node) {
    if (ts.isCallExpression(node) && node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0])) {
      const options = node.arguments[0];
      const id = property(options, 'id')?.initializer;
      const name = property(options, 'name')?.initializer;
      if (id && ts.isStringLiteralLike(id) && id.text === 'reader'
        && name && ts.isStringLiteralLike(name) && name.text === 'conversation.view') {
        readerCount++;
        readerInject = property(options, 'inject')?.initializer.getText(ast);
      }
    }
    ts.forEachChild(node, findReader);
  }
  findReader(apply);
  if (readerCount !== 1 || !readerInject) throw new Error('Reader session capability injection changed');
  const migration = findFunction(body, 'installReaderEntry');
  const obsoleteRequest = findFunction(body, 'readerEntryRequested');
  const obsoletePolicy = body.statements.filter(node => ts.isVariableStatement(node)
    && node.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name)
      && declaration.name.text === 'ReaderEntryPolicy'));
  if (obsoletePolicy.length !== 1) throw new Error('Reader standalone-entry policy changed');
  const replacementApply = `function apply(ctx) {
    const store = createReaderStore();
    const prefs = store.create();
    installBetterDisplaySettings(ctx, prefs);
    const readerInject = ${readerInject};
    ctx.slots.inject("conversation.chat.node", function* () {
      yield installNativeReader(ctx, prefs, readerInject);
      yield installReaderEntry(ctx);
    });
  }`;
  const replacementMigration = `function installReaderEntry(ctx) {
    const native = ctx.slots.entriesOfSlot("conversation.session")[0]?.store;
    if (!isConversationStore(native)) throw new Error("Reader cannot bind the native conversation view store.");
    return ctx.slots.register({
      name: "conversation.input.dock",
      id: "nexus-chat-display-migration",
      store: native,
      inject: () => ({ policy: { select: (view) => view === "reader" ? "chat" : null } })
    }, ReaderEntry);
  }`;
  const edits = [
    { start: apply.getStart(ast) - offset, end: apply.end - offset, text: `${installNativeReader.toString()}\n${replacementApply}` },
    { start: migration.getStart(ast) - offset, end: migration.end - offset, text: replacementMigration },
    { start: obsoleteRequest.getStart(ast) - offset, end: obsoleteRequest.end - offset, text: '' },
    { start: obsoletePolicy[0].getStart(ast) - offset, end: obsoletePolicy[0].end - offset, text: '' },
  ];
  // Auto-fold remains the native four-level, Host-backed process preference.
  // Reuse the redundant row for Reader's motion preference, which was formerly
  // reachable only through the removed standalone Reader page toolbar.
  const settings = findFunction(body, 'SettingsSection');
  let foldRow;
  function findFold(node) {
    if (ts.isPropertyAssignment(node) && ts.isStringLiteralLike(node.name)
      && node.name.text === 'data-better-display-auto-fold') {
      let parent = node.parent;
      while (parent && parent !== settings) {
        if (ts.isCallExpression(parent) && parent.arguments[0]
          && ts.isStringLiteralLike(parent.arguments[0]) && parent.arguments[0].text === 'div') {
          foldRow = parent;
          break;
        }
        parent = parent.parent;
      }
    }
    ts.forEachChild(node, findFold);
  }
  findFold(settings);
  if (!foldRow) throw new Error('Reader redundant fold setting changed');
  edits.push({
    start: foldRow.getStart(ast) - offset,
    end: foldRow.end - offset,
    text: `react.createElement("div", { className: SettingsSection_module_css_default.row },
      react.createElement("div", { className: SettingsSection_module_css_default.rowText },
        react.createElement("div", { className: SettingsSection_module_css_default.title },
          settingsLanguage(props.languageTag) === "zh" ? "文字到达动画" : "Text arrival animation"),
        react.createElement("div", { className: SettingsSection_module_css_default.desc },
          settingsLanguage(props.languageTag) === "zh" ? "逐字呈现新收到的正文和思考；遵循系统减少动态效果设置。" : "Animate newly received text and reasoning; respect the system reduced-motion preference.")),
      react.createElement("button", {
        type: "button", role: "switch",
        "aria-label": settingsLanguage(props.languageTag) === "zh" ? "文字到达动画" : "Text arrival animation",
        "aria-checked": snap.motion !== false,
        className: SettingsSection_module_css_default.switch,
        "data-on": snap.motion !== false || undefined,
        "data-better-display-motion": snap.motion !== false ? "on" : "off",
        onClick: () => props.prefs.actions.setMotion(snap.motion === false)
      }))`,
  });
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    factory = factory.slice(0, edit.start) + edit.text + factory.slice(edit.end);
  }
  // Reuse only Reader's optional glass styling under the native assistant.
  // Its old page root also owns padding, type size and sticky toolbar offsets;
  // those page-level rules must not become a second layout inside ChatFlow.
  const glassRoot = '.gNoOdq_root[data-reader-glass]';
  if (!factory.includes(glassRoot)) throw new Error('Reader optional glass style contract changed');
  factory = factory.replaceAll(glassRoot, '[data-nexus-chat-display][data-reader-glass]');
  return factory;
}
