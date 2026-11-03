import { main } from './main';

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exitCode = code;
  },
  (e: unknown) => {
    process.stderr.write(`pakkon: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 2;
  },
);
