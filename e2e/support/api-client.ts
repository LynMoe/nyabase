export interface ApiRequestOptions {
  data?: unknown;
  headers?: Record<string, string>;
}

export interface ApiResponse {
  status(): number;
  ok(): boolean;
  url(): string;
  headers(): Record<string, string>;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export interface ApiClient {
  get(path: string, options?: ApiRequestOptions): Promise<ApiResponse>;
  post(path: string, options?: ApiRequestOptions): Promise<ApiResponse>;
  patch(path: string, options?: ApiRequestOptions): Promise<ApiResponse>;
  put(path: string, options?: ApiRequestOptions): Promise<ApiResponse>;
  delete(path: string, options?: ApiRequestOptions): Promise<ApiResponse>;
  fetch(path: string, options?: ApiRequestOptions & { method?: string }): Promise<ApiResponse>;
  dispose(): Promise<void>;
}

export interface ApiClientOptions {
  baseURL: string;
  extraHTTPHeaders?: Record<string, string>;
}

class FetchApiResponse implements ApiResponse {
  constructor(
    private readonly response: Response,
    private readonly requestUrl: string,
    private readonly bodyText: string,
  ) {}

  status(): number {
    return this.response.status;
  }

  ok(): boolean {
    return this.response.ok;
  }

  url(): string {
    return this.response.url || this.requestUrl;
  }

  headers(): Record<string, string> {
    const values: Record<string, string> = {};
    this.response.headers.forEach((value, key) => {
      values[key] = value;
    });
    return values;
  }

  async text(): Promise<string> {
    return this.bodyText;
  }

  async json(): Promise<unknown> {
    return JSON.parse(this.bodyText);
  }
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const baseURL = options.baseURL.replace(/\/$/, '');
  const defaultHeaders = { ...(options.extraHTTPHeaders ?? {}) };

  const send = async (
    method: string,
    path: string,
    requestOptions: ApiRequestOptions = {},
  ): Promise<ApiResponse> => {
    const url = path.startsWith('http://') || path.startsWith('https://')
      ? path
      : `${baseURL}${path.startsWith('/') ? path : `/${path}`}`;
    const headers: Record<string, string> = {
      accept: 'application/json',
      ...defaultHeaders,
      ...(requestOptions.headers ?? {}),
    };
    let body: string | undefined;
    if (requestOptions.data !== undefined) {
      headers['content-type'] = headers['content-type'] ?? 'application/json';
      body = JSON.stringify(requestOptions.data);
    }
    const response = await fetch(url, { method, headers, body });
    const bodyText = await response.text();
    return new FetchApiResponse(response, url, bodyText);
  };

  return {
    get: (path, requestOptions) => send('GET', path, requestOptions),
    post: (path, requestOptions) => send('POST', path, requestOptions),
    patch: (path, requestOptions) => send('PATCH', path, requestOptions),
    put: (path, requestOptions) => send('PUT', path, requestOptions),
    delete: (path, requestOptions) => send('DELETE', path, requestOptions),
    fetch: (path, requestOptions = {}) => send(
      (requestOptions.method ?? 'GET').toUpperCase(),
      path,
      requestOptions,
    ),
    async dispose() {},
  };
}
