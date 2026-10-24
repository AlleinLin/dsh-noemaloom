/** The native tools keep their original owner's registry layer and policy gates. */
export function crossSessionTools(ctx, registry) {
  return {
    register(definition) {
      const execute = definition.execute;
      return registry.register({
        ...definition,
        async execute(args, exec) {
          const relay = ctx.get('nexusCrossSessionMailbox');
          if (!relay) throw new Error('[NX_MAIL_CAPABILITY_UNAVAILABLE] Unified cross-session mailbox is unavailable.');
          await relay.authorizeTool(exec.agent, args, exec.signal);
          if (['cross_session_spawn', 'cross_session_rename', 'cross_session_archive'].includes(definition.name)) {
            await relay.beforeResume(exec.agent, exec.agent.id, exec.signal);
            return relay.executeOnce(definition.name, exec.agent, exec.callId, args, () => execute(args, exec));
          }
          return execute(args, exec);
        },
        output: definition.output && {
          ...definition.output,
          render(args, value) {
            if (value.mailbox) return [{ type: 'text', text: JSON.stringify(value) }];
            if (Array.isArray(value.results) && value.results.some(row => row.mailbox)) {
              return [{ type: 'text', text: JSON.stringify(value) }];
            }
            return definition.output.render(args, value);
          },
        },
      });
    },
  };
}
