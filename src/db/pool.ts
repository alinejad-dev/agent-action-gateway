import { dbConfig } from './dbConfig.js';
import { createPool } from './dbSettings.js';

// One shared pool for the scripts. Creating it does not connect yet:
// connections open on the first query and are reused after that.
// TLS, limits and timeouts are set in poolOptions (dbSettings.ts).
export const pool = createPool(dbConfig);