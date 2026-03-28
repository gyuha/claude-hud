import type { UsageData } from './types.js';
type FetchImpl = typeof fetch;
export declare function getGlmUsageData(): Promise<UsageData | null>;
export declare function _setFetchImplForTests(impl: FetchImpl | null): void;
export {};
//# sourceMappingURL=glm-usage.d.ts.map