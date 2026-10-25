import { Pane, type FolderApi } from 'tweakpane';
import { TUNABLES } from '@wd/shared';

/**
 * Dev-only live editor for `shared/src/config/tunables.ts` (backtick to toggle). Values change
 * the running sim immediately; "Copy as TS" puts the current values on the clipboard so Kiran
 * can paste tuned numbers back into the tunables module.
 */
export function createTuningPanel(): { toggle: () => void } {
  const pane = new Pane({ title: 'Tunables (dev)', expanded: true });
  pane.element.parentElement!.classList.add('tuning');
  pane.hidden = true;

  const bindObject = (folder: FolderApi | Pane, obj: Record<string, unknown>): void => {
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'number') {
        const mag = Math.max(1, Math.abs(value));
        folder.addBinding(obj, key, { min: 0, max: mag * 4, step: mag < 5 ? 0.01 : 0.1 });
      } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        const sub = folder.addFolder({ title: key, expanded: false });
        bindObject(sub, value as Record<string, unknown>);
      }
    }
  };
  for (const [group, obj] of Object.entries(TUNABLES)) {
    const folder = pane.addFolder({
      title: group,
      expanded: group === 'MOVEMENT' || group === 'RIFLE',
    });
    bindObject(folder, obj);
  }
  pane.addButton({ title: 'Copy as TS' }).on('click', () => {
    const text = Object.entries(TUNABLES)
      .map(([k, v]) => `export const ${k} = ${JSON.stringify(v, null, 2)};`)
      .join('\n\n');
    void navigator.clipboard.writeText(text);
  });
  return {
    toggle: () => {
      pane.hidden = !pane.hidden;
    },
  };
}
