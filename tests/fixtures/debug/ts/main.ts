import { doubled as dependencyDoubled } from 'nexus-debug-fixture';
function doubled(value: number): number {
  const result = dependencyDoubled(value);
  return result;
}
const input = 21;
const answer = doubled(input);
console.log(`answer=${answer}`);
