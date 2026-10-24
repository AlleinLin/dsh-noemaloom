import ts from 'typescript';

function once(source, anchor, replacement) {
  const offset = source.indexOf(anchor);
  if (offset < 0 || source.indexOf(anchor, offset + anchor.length) !== -1) {
    throw new Error(`Cross-session upstream anchor changed: ${anchor.slice(0, 90)}`);
  }
  return source.slice(0, offset) + replacement + source.slice(offset + anchor.length);
}
function replaceFunction(source, name, replacement) {
  const ast = ts.createSourceFile('cross-session.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const declarations = ast.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  if (declarations.length !== 1) throw new Error(`Cross-session expected one ${name} function`);
  const node = declarations[0];
  return source.slice(0, node.getStart(ast)) + replacement + source.slice(node.end);
}

export function adaptCrossSessionHost(original) {
  let source = once(original, "const tools = ctx.get('tools');", `const tools = crossSessionTools(ctx, ctx.get('tools'));
  const nexusBridgeDelivery = new AbortController();
  const nexusBridgeTasks = new Set();`);
  source = replaceFunction(source, 'deliver', `async function deliver(ctx, caller, targetAgent, text, { preempt = true, wake = true } = {}, requestId, signal) {
  return ctx.get('nexusCrossSessionMailbox').send(caller, {
    target: targetAgent.id, content: [{ type: 'text', text }], requestId,
    delivery: preempt ? 'steer' : 'queue', wake
  }, signal);
}`);
  source = once(source,
    'async function ensureLiveAgent(ctx, agents, handles, resuming, sessionId, signal, storedPreset, blocked, isLive) {',
    `async function ensureLiveAgent(ctx, agents, handles, resuming, sessionId, signal, storedPreset, blocked, isLive, caller) {
  await ctx.get('nexusCrossSessionMailbox').beforeResume(caller, sessionId, signal);`);
  const callAnchor = 'blockedSpawns, callGuard.live)';
  if (source.split(callAnchor).length !== 5) throw new Error('Cross-session expected four native cold-resume call sites');
  source = source.replaceAll(callAnchor, 'blockedSpawns, callGuard.live, caller)');
  source = once(source, 'let handle;', 'let handle;\n      let spawnReceipt;');
  source = once(source, `handles.set(sessionId, handle);
        deliver(handle.agent, taskMessage);
        blockedSpawns.delete(sessionId);`,
  `handles.set(sessionId, handle);
        blockedSpawns.delete(sessionId);
        await ctx.get('nexusCrossSessionMailbox').recordDelegation(caller, handle.agent, exec.signal);
        spawnReceipt = await deliver(ctx, caller, handle.agent, taskMessage, {}, 'cross-spawn:' + exec.callId, exec.signal);`);
  source = once(source, "status: 'task_sent',", "status: spawnReceipt.state === 'accepted' || spawnReceipt.state === 'consumed' ? 'task_sent' : spawnReceipt.state,\n        mailbox: spawnReceipt,");
  source = once(source,
    'deliver(agent, clampText(args.message) + directive, { preempt: args.interrupt !== false, wake: args.wake !== false });',
    "const receipt = await deliver(ctx, caller, agent, clampText(args.message) + directive, { preempt: args.interrupt !== false, wake: args.wake !== false }, 'cross-send:' + exec.callId, exec.signal);");
  source = once(source, "status: args.wake === false ? 'queued' : 'delivered',",
    'status: receipt.state,\n        mailbox: receipt,');
  source = once(source, 'deliver(agent, replyText);',
    "const receipt = await deliver(ctx, caller, agent, replyText, {}, 'cross-reply:' + exec.callId, exec.signal);");
  source = once(source, "return { delivered: true, woken: true, mode: resumed ? 'resumed' : 'live' };",
    "return { delivered: ['accepted','consumed'].includes(receipt.state), woken: ['accepted','consumed'].includes(receipt.state), mode: resumed ? 'resumed' : 'live', mailbox: receipt };");
  source = once(source,
    'deliver(resolved.agent, clampText(target.message) + directive, { preempt: target.interrupt !== false, wake: target.wake !== false });',
    "const receipt = await deliver(ctx, caller, resolved.agent, clampText(target.message) + directive, { preempt: target.interrupt !== false, wake: target.wake !== false }, 'cross-broadcast:' + exec.callId + ':' + results.length, exec.signal);");
  source = once(source, 'resumed: resolved.resumed,', 'resumed: resolved.resumed,\n            mailbox: receipt,');
  source = once(source, 'noticeDelivered: false,', `noticeDelivered: false,
      nexusNoticeController: new AbortController(),`);
  source = once(source, 'entry.done = true;', `entry.done = true;
      // The pending durable mailbox send must not survive the approval key.
      // Accepted/unknown receipts remain authoritative and are never replayed.
      entry.nexusNoticeController.abort(new Error('The approval request is terminal.'));`);
  source = once(source, 'if (entry.withdrawSent) return;', `if (entry.withdrawSent) return;
      if (instanceDisposed || entry.epoch !== instanceEpoch || nexusBridgeDelivery.signal.aborted) return;`);
  source = once(source, `live.steer(createUserMessage({
            content: [{ type: 'text', text: \`【跨会话审批桥】此前的审批请求（key=\${entry.key}）已终止（\${reason}）。请勿再用该 key 调用 cross_session_approve；请求已由本地 UI 通道处理或已取消。\` }],
            source: { kind: 'user' },
          }));`,
  `const withdrawal = new AbortController();
          const timer = setTimeout(() => withdrawal.abort(new Error('The terminal approval notice expired.')), 5000);
          timer.unref?.();
          // A withdrawal is a new terminal notice, so it survives request abort,
          // but only within this plugin generation and this bounded delivery.
          const signal = AbortSignal.any([nexusBridgeDelivery.signal, withdrawal.signal]);
          const task = (async () => {
            try {
              const receipt = await deliver(ctx, entry.requesterAgent, live,
                \`【跨会话审批桥】此前的审批请求（key=\${entry.key}）已终止（\${reason}）。请勿再用该 key 调用 cross_session_approve；请求已由本地 UI 通道处理或已取消。\`,
                { wake: false }, 'approval-withdraw:' + entry.key, signal);
              if (['queued', 'held'].includes(receipt.state)) {
                await ctx.get('nexusCrossSessionMailbox').cancelPending(entry.requesterAgent, receipt.message_id);
              }
            } catch { /* no automatic replay of a terminal notice */ }
            finally { clearTimeout(timer); withdrawal.abort(); }
          })();
          nexusBridgeTasks.add(task);
          void task.finally(() => nexusBridgeTasks.delete(task)).catch(() => {});`);
  source = once(source, `live.steer(createUserMessage({
      content: [{ type: 'text', text: notice }],
      source: { kind: 'user' },
    }));`,
  `if (instanceDisposed || entry.epoch !== instanceEpoch || Date.now() >= entry.deadlineAt) return false;
    const signal = AbortSignal.any([nexusBridgeDelivery.signal, entry.nexusNoticeController.signal,
      ...(entry.rec?.exec?.signal ? [entry.rec.exec.signal] : [])]);
    signal.throwIfAborted();
    const receipt = await deliver(ctx, entry.requesterAgent, live, notice, {},
      'approval-notice:' + entry.key, signal);
    if (!['accepted', 'consumed'].includes(receipt.state)) {
      entry.nexusNoticeController.abort(new Error('The approval notice was not accepted; do not dispatch it later.'));
      if (['queued', 'held'].includes(receipt.state)) {
        await ctx.get('nexusCrossSessionMailbox').cancelPending(entry.requesterAgent, receipt.message_id);
      }
      return false;
    }`);
  source = once(source, `void deliverToApprover(owner, notice, entry)
      .then((delivered) => { if (!delivered) entry.finish(DELEGATE); },
            () => entry.finish(DELEGATE));`,
  `const noticeTask = deliverToApprover(owner, notice, entry)
      .then((delivered) => { if (!delivered) entry.finish(DELEGATE); },
            () => entry.finish(DELEGATE));
    nexusBridgeTasks.add(noticeTask);
    void noticeTask.finally(() => nexusBridgeTasks.delete(noticeTask)).catch(() => {});`);
  source = once(source, "ctx.effect(() => () => {\n    instanceDisposed = true;",
    "ctx.effect(() => async () => {\n    instanceDisposed = true;");
  source = once(source, 'instanceDisposed = true;', `instanceDisposed = true;
    nexusBridgeDelivery.abort(new Error('The approval bridge plugin was unloaded.'));`);
  source = once(source, 'activeRequests.clear();', `activeRequests.clear();
    // The provider stays live until every canceled queued send is terminal.
    await Promise.allSettled([...nexusBridgeTasks]);
    nexusBridgeTasks.clear();`);
  if (/source:\s*\{\s*kind:\s*['"]user['"]/u.test(source)) {
    throw new Error('Cross-session unreviewed human-source path remains');
  }
  // Scope-check every resolved target before reading, renaming, archiving or
  // resuming it. Preserve the original base62 resolver and exact tool schemas.
  const ast = ts.createSourceFile('cross-session.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const positions = [];
  function visit(node) {
    if (ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration =>
      ts.isIdentifier(declaration.name) && ['targetId', 'toId'].includes(declaration.name.text)
      && declaration.initializer?.getText(ast).startsWith('resolveSessionIdOrThrow('))) {
      const target = node.declarationList.declarations.find(declaration => ['targetId', 'toId'].includes(declaration.name.getText(ast)));
      positions.push([node.end, `\n      await ctx.get('nexusCrossSessionMailbox').authorizeTarget(caller, ${target.name.getText(ast)}, exec.signal);`]);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  if (positions.length !== 6) throw new Error(`Cross-session expected six scope-checked targets, found ${positions.length}`);
  for (const [offset, text] of positions.sort(([a], [b]) => b - a)) source = source.slice(0, offset) + text + source.slice(offset);
  return "import { crossSessionTools } from './nexus-tools.mjs';\n" + source;
}
