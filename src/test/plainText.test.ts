/** "Copy as plain text", against output captured from a real Claude Code session. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { plainText } from '../core/plainText';

const FIX = path.join(__dirname, '..', '..', 'src', 'test', 'fixtures');
const load = (f: string) => JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8')) as { cols: number; lines: string[] };

test('a real answer becomes paragraphs, a list and a quote — no bullets, bars, indents or footer', () => {
  const fx = load('claude-tui-es.json');
  const out = plainText(fx.lines.join('\n'), fx.cols);
  assert.equal(out, [
    'Importancia de los Respaldos',
    '',
    'Los respaldos son la póliza de seguro de tus datos. Sin ellos, un error, un ataque cibernético o un fallo técnico pueden significar pérdida permanente de información valiosa. Un respaldo confiable te permite recuperarte rápidamente, minimizar el tiempo de inactividad y proteger años de trabajo, proyectos y recuerdos acumulados.',
    '',
    'Los respaldos también te liberan de la ansiedad constante de "¿y si algo sale mal?". Actúan como red de contención ante lo inesperado: corrupción de archivos, ransomware, desastres naturales o simplemente un mal clic. Invertir tiempo en respaldos regulares es invertir en tranquilidad y continuidad empresarial.',
    '',
    '- Protección contra pérdida de datos irreversible por hardware o software',
    '- Recuperación rápida ante ataques, errores o desastres naturales',
    '- Cumplimiento normativo y legal en sectores regulados',
    '',
    '> "Un respaldo que no has probado es como un paracaídas que nunca has saltado."',
    '',
    'Planifica tus respaldos hoy → Duerme tranquilo mañana —',
  ].join('\n'));
});

test('a wrapped list item is rejoined into its item, never into the next one', () => {
  const fx = load('claude-tui-list-es.json');
  assert.equal(plainText(fx.lines.join('\n'), fx.cols), [
    '- Previenen pérdida permanente de datos en casos de falla de hardware',
    '- Facilitan la recuperación rápida ante ataques cibernéticos o ransomware',
    '- Permiten migrar a nuevos dispositivos conservando toda tu información intacta',
    '',
    '> "Un respaldo hoy puede salvarte de un desastre mañana."',
    '',
    '→ —',
  ].join('\n'));
});

test('short deliberate lines (code, an address) are never joined', () => {
  const code = '⏺ Run this:\n\n  npm install\n  npm test\n  git push';
  assert.equal(plainText(code, 80), 'Run this:\n\nnpm install\nnpm test\ngit push');
});

test('a selection without TUI scaffolding passes through unchanged', () => {
  assert.equal(plainText('hola → mundo — á\nsegunda línea', 80), 'hola → mundo — á\nsegunda línea');
  assert.equal(plainText('', 80), '');
});
