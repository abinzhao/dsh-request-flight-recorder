export interface WebGatePage {
  goto(
    url: string,
    options: { readonly waitUntil: 'domcontentloaded' },
  ): Promise<unknown>
}

export interface WebGateChild {
  readonly exitCode: number | null
}

export interface WebGateOptions {
  readonly timeoutMs?: number
  readonly retryMs?: number
}

export function navigateWhenReady(
  page: WebGatePage,
  url: string,
  child: WebGateChild,
  output: () => string,
  options?: WebGateOptions,
): Promise<void>
