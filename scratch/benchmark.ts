import { RequestCoalescer } from '../src/index';

// A mock slow database query taking 100ms
let dbQueriesCount = 0;
const mockDbQuery = async (userId: string): Promise<string> => {
  dbQueriesCount++;
  // Simulate network delay
  return new Promise((resolve) => setTimeout(() => resolve(`user-data-${userId}`), 100));
};

async function run() {
  console.log('==================================================');
  console.log('        REQUEST-COALESCER BENCHMARK SUITE         ');
  console.log('==================================================\n');

  const concurrentRequests = 1000;
  console.log(`Simulating ${concurrentRequests} concurrent requests for same user ID...\n`);

  // --- Scenario 1: Without Request Coalescing ---
  dbQueriesCount = 0;
  const startNoCoalesce = Date.now();
  
  const promisesWithout = [];
  for (let i = 0; i < concurrentRequests; i++) {
    promisesWithout.push(mockDbQuery('123'));
  }
  
  await Promise.all(promisesWithout);
  const timeNoCoalesce = Date.now() - startNoCoalesce;
  
  console.log('[Scenario 1: Raw Concurrent Requests (No Coalescing)]');
  console.log(`- Time taken: ${timeNoCoalesce}ms`);
  console.log(`- Underlying Database/API calls: ${dbQueriesCount}`);
  console.log('--------------------------------------------------\n');

  // --- Scenario 2: With Request Coalescing ---
  const coalescer = new RequestCoalescer();
  dbQueriesCount = 0;
  const startWithCoalesce = Date.now();

  const promisesWith = [];
  for (let i = 0; i < concurrentRequests; i++) {
    promisesWith.push(coalescer.coalesce('user:123', () => mockDbQuery('123')));
  }

  await Promise.all(promisesWith);
  const timeWithCoalesce = Date.now() - startWithCoalesce;

  console.log('[Scenario 2: Coalesced Requests (Promise Sharing)]');
  console.log(`- Time taken: ${timeWithCoalesce}ms`);
  console.log(`- Underlying Database/API calls: ${dbQueriesCount}`);
  console.log('- Telemetry stats:', coalescer.getStats());
  console.log('==================================================');

  // Assert optimization ratio
  const queryReduction = ((concurrentRequests - dbQueriesCount) / concurrentRequests) * 100;
  console.log(`\n Success! Database queries reduced by ${queryReduction.toFixed(2)}%!`);
}

run().catch(console.error);
