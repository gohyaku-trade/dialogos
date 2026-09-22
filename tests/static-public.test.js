import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { app } from '../server.js';

test('static server exposes UI/catalog but not source, SQL or private files', async t => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = 'http://127.0.0.1:' + server.address().port;
  for (const path of ['/', '/index.html', '/js/app.js', '/js/data/takeawayPersonas.js', '/js/services/takeawayService.js', '/js/services/metrics.js', '/js/ui/takeawayDialog.js', '/terms.html', '/api/packages']) {
    assert.equal((await fetch(origin + path)).status, 200, path);
  }
  for (const path of ['/server.js', '/package.json', '/.env', '/supabase/schema.sql', '/supabase/005_daily_trial.sql', '/supabase/006_anonymous_trial.sql', '/shared/dialogue.js', '/lib/api-v3.js', '/lib/guest-security.js', '/admin.html', '/assets/images/socrates/profile.png', '/assets/images/socrates/%70rofile.png']) {
    assert.equal((await fetch(origin + path)).status, 404, path);
  }
});

test('only the API entrypoint is deployed as a function', () => {
  assert.deepEqual(readdirSync(new URL('../api/', import.meta.url)), ['index.js']);
  assert.ok(existsSync(new URL('../lib/api-v3.js', import.meta.url)));
});
