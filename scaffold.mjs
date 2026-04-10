import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

const base = 'C:\\Jonah\\AI Project\\mediextract_5';

const dirs = [
  'app/api/process',
  'app/demo',
  'lib',
  'components',
];

dirs.forEach(d => {
  mkdirSync(join(base, d), { recursive: true });
  console.log('created dir:', d);
});

const files = [
  'lib/claude.ts',
  'lib/validator.ts',
  'lib/preprocessor.ts',
  'components/PipelineSteps.tsx',
  'components/FieldCard.tsx',
  'components/UploadZone.tsx',
  'app/api/process/route.ts',
  'app/demo/page.tsx',
];

files.forEach(f => {
  const full = join(base, f);
  if (!existsSync(full)) {
    writeFileSync(full, '// placeholder\n');
    console.log('created file:', f);
  } else {
    console.log('already exists:', f);
  }
});

console.log('\nScaffold complete.');