/* Browser entry for the DSH client module loader; no host process is imported. */
window.__ModuleLoader__.load({
  id: '@waeotech/harness-bridge',
  factory: require => {
    const React = require('react');
    const h = React.createElement;
    const namespace = 'tool-harness-bridge';
    const fieldStyle = { display: 'grid', gap: 8, marginBottom: 22 };
    const selectStyle = { padding: '10px 12px', border: '1px solid #9ca3af', borderRadius: 8, color: 'inherit', background: 'transparent', font: 'inherit', maxWidth: 460 };

    function BridgeSettings({ view, scope }) {
      const snapshot = React.useSyncExternalStore(listener => scope.subscribe(listener), () => scope.getSnapshot());
      const [busy, setBusy] = React.useState(false);
      const [notice, setNotice] = React.useState('');
      if (view === 'summary') return 'Choose Claude Code language, execution mode, and edit proposals.';
      const settings = snapshot.value;
      if (snapshot.status !== 'ready' || !settings) return h('p', null, snapshot.status === 'loading' ? 'Loading settings…' : 'Harness Bridge settings are unavailable.');
      const disabled = busy || !snapshot.writable;
      async function update(field, value) {
        setBusy(true);
        setNotice('Saving…');
        try {
          const accepted = await scope.set(field, value);
          setNotice(accepted ? 'Saved. Applies to the next Claude Code task.' : 'The deployment did not accept this change. Check the current value and try again.');
        } catch {
          setNotice('Could not save settings. Check the connection and try again.');
        } finally {
          setBusy(false);
        }
      }
      return h('section', { 'aria-label': 'Harness Bridge settings' },
        h('p', { style: { margin: '0 0 24px', lineHeight: 1.6 } }, 'DSH delegates to Claude Code, streams its tool activity, and keeps Git and review authority.'),
        h('label', { style: fieldStyle },
          h('strong', null, 'Claude Code language'),
          h('span', null, 'DSH translates your request into this language and summarizes the result in your conversation language.'),
          h('select', { 'aria-label': 'Claude Code language', style: selectStyle, disabled, value: settings.language ?? settings.profile ?? 'zh-CN', onChange: event => update('language', event.target.value) },
            ...[['zh-CN', '简体中文 · zh-CN'], ['en-US', 'English (US) · en-US'], ['en-GB', 'English (UK) · en-GB'], ['ja-JP', '日本語 · ja-JP']].map(([value, label]) => h('option', { key: value, value }, label)))),
        h('label', { style: fieldStyle },
          h('strong', null, 'Execution mode'),
          h('span', null, 'Both modes stream real CC tool events into DSH. tmux also provides a local terminal pane you can attach to.'),
          h('select', { 'aria-label': 'Execution mode', style: selectStyle, disabled, value: settings.transport, onChange: event => update('transport', event.target.value) },
            h('option', { value: 'headless' }, 'Headless · structured events'),
            h('option', { value: 'tmux' }, 'tmux · attachable terminal + events'))),
        h('label', { style: { ...fieldStyle, gridTemplateColumns: '20px 1fr', alignItems: 'start' } },
          h('input', { type: 'checkbox', disabled, checked: settings.allowEdits, onChange: event => update('allowEdits', event.target.checked), 'aria-label': 'Allow edit proposals' }),
          h('span', null, h('strong', null, 'Allow edit proposals'), h('span', { style: { display: 'block', marginTop: 8, lineHeight: 1.6 } }, 'CC edits a Git-free copy. DSH inspects the proposal and applies only an explicitly authorized digest. Git operations run in DSH.'))),
        h('p', { style: { opacity: 0.75, lineHeight: 1.6 } }, 'Language preferences do not establish nationality, location, or account eligibility.'),
        !snapshot.writable && h('p', { role: 'status' }, 'This deployment stores settings read-only.'),
        h('p', { role: 'status', 'aria-live': 'polite', style: { minHeight: 24 } }, notice));
    }

    return {
      inject: ['slots', 'configForms'],
      apply(ctx) {
        const scope = ctx.configForms.get(namespace);
        ctx.effect(() => ctx.configForms.whileServed([namespace], () => ctx.slots.inject('plugins.item', () => ctx.slots.register({
          name: 'plugins.item', id: 'harness-bridge', order: 45,
          label: () => 'Harness Bridge', inject: () => ({ scope }),
        }, BridgeSettings))), 'harness-bridge: configuration page');
      },
    };
  },
});
