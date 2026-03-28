import type { StdinData, UsageData } from './types.js';
import { getGlmUsageData } from './glm-usage.js';
export declare function readStdin(): Promise<StdinData | null>;
export declare function getTotalTokens(stdin: StdinData): number;
export declare function getContextPercent(stdin: StdinData): number;
export declare function getBufferedPercent(stdin: StdinData): number;
export declare function getModelName(stdin: StdinData): string;
export declare function isBedrockModelId(modelId?: string): boolean;
export declare function getProviderLabel(stdin: StdinData): string | null;
export declare function isGlmBaseUrl(baseUrl?: string): boolean;
export declare function getUsageFromStdin(stdin: StdinData): Promise<UsageData | null>;
export declare function _setGlmUsageGetterForTests(impl: typeof getGlmUsageData | null): void;
//# sourceMappingURL=stdin.d.ts.map