function once(source, anchor, replacement, label) {
  const position = source.indexOf(anchor);
  if (position < 0 || source.indexOf(anchor, position + anchor.length) >= 0) throw new Error(`Agent integration ${label}: pinned source changed`);
  return source.slice(0, position) + replacement + source.slice(position + anchor.length);
}
/** Keep the original tree/graph, polls and team model; share one cache. */
export function adaptAgentClient(factory) {
  let source = once(factory, 'function SubagentView(props) {',
    `const nexusAgentFacts = require("@local/dsh-nexus/agent-insights");
    function SubagentView(props) {
      return react_jsx_runtime.jsx(nexusAgentFacts.AgentInsightsProvider, {
        ctx: props.ctx, sessionId: props.sessionId, active: props.active,
        children: react_jsx_runtime.jsx(NexusBaseSubagentView, props)
      });
    }
    function NexusBaseSubagentView(props) {`, 'provider');
  const treeAnchor = 'node.state === "running" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(LiveLine, { live: node.live }),';
  source = once(source, treeAnchor, `${treeAnchor}
    react_jsx_runtime.jsx(nexusAgentFacts.AgentFacts, {node}),`, 'tree facts');
  const start = source.indexOf('function renderAgentNode(');
  const end = source.indexOf('function renderWorkflowNode(', start);
  if (start < 0 || end < 0) throw new Error('Agent integration graph source changed');
  const part = source.slice(start, end);
  const child = `children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TaskLine, {
\t\t\t\t\t\ttasks: node.tasks,
\t\t\t\t\t\tonOpenTask
\t\t\t\t\t})`;
  source = source.slice(0, start) + once(part, child, `children: react_jsx_runtime.jsxs(react.Fragment, {children: [
      react_jsx_runtime.jsx(TaskLine, {tasks: node.tasks, onOpenTask}),
      react_jsx_runtime.jsx(nexusAgentFacts.AgentFacts, {node})
    ]})`, 'graph facts') + source.slice(end);
  source = once(source, 'const base = 87;', 'const base = 87 + 64;', 'card geometry');
  return source;
}
