import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { startApp, until } from '../../../scripts/test/harness.mjs';
import { rpc, createStoredSession } from '../../support/desktop.mjs';

export const cases = {
  async 'sessions.delete-confirmation'({ dir }) {
    const app = await startApp(join(dir, 'ux-delete-visibility'));
    try {
      const page = app.page;
      await createStoredSession(page);
      const measurements = [];
      for (const theme of ['light', 'dark']) {
        const toggle = page.getByRole('button', {
          name: theme === 'light' ? '切换到浅色模式' : '切换到深色模式',
        });
        if (await toggle.count()) await toggle.click();
        await page.getByRole('button', { name: '会话操作', exact: true }).click();
        await page.getByRole('menuitem', { name: '删除会话', exact: true }).click();
        const confirm = page.getByRole('button', { name: '确认删除会话', exact: true });
        await until(() => confirm.isEnabled(), 'deletion preview ready');
        for (const state of ['normal', 'hover', 'focus']) {
          if (state === 'hover') await confirm.hover();
          if (state === 'focus') {
            await page.mouse.move(0, 0);
            await page.getByRole('button', { name: '取消', exact: true }).focus();
            await page.keyboard.press('Tab');
            assert(await confirm.evaluate((n) => n === document.activeElement));
          }
          await confirm.evaluate(async (n) => {
            await Promise.all(n.getAnimations().map((animation) => animation.finished));
          });
          // DOM visibility/clickability alone misses white text on a white dialog.
          const colors = await confirm.evaluate((n) => {
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = 1;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#fff';
            ctx.fillRect(0, 0, 1, 1);
            const ancestors = [];
            for (let el = n; el; el = el.parentElement) ancestors.unshift(el);
            for (const el of ancestors) {
              ctx.fillStyle = getComputedStyle(el).backgroundColor;
              ctx.fillRect(0, 0, 1, 1);
            }
            const background = [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
            ctx.fillStyle = getComputedStyle(n).color;
            ctx.fillRect(0, 0, 1, 1);
            return {
              background,
              foreground: [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3),
              cssBackground: getComputedStyle(n).backgroundColor,
            };
          });
          const luminance = (rgb) =>
            rgb.reduce((sum, value, i) => {
              const c = value / 255;
              return (
                sum +
                (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4) *
                  [0.2126, 0.7152, 0.0722][i]
              );
            }, 0);
          const a = luminance(colors.background),
            b = luminance(colors.foreground);
          const contrast = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
          measurements.push({ theme, state, ...colors, contrast });
          writeFileSync(join(dir, 'delete-contrast.json'), JSON.stringify(measurements, null, 2));
          await page
            .getByRole('dialog')
            .screenshot({ path: join(dir, `delete-${theme}-${state}.png`) });
          assert(
            contrast >= 4.5,
            `${theme}/${state} confirm contrast ${contrast}: ${JSON.stringify(colors)}`,
          );
        }
        await page.getByRole('button', { name: '取消', exact: true }).click();
        assert.equal((await rpc(page, { type: 'sessions.list' })).length, 1);
      }
      assert.deepEqual(app.errors, []);
      return { measurements, cancelPreservesSession: true };
    } finally {
      await app.stop();
    }
  },
};
