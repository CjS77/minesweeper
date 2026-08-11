import { describe, expect, it } from "vitest";

import { createCommitPublisher, CommitPublisherError } from "../commit.js";

/** One recorded request the fake fetch saw. */
interface RecordedRequest {
  url: string;
  method: string;
  authorization: string;
  body: string | null;
}

function fakeFetch(routes: Record<string, (body: unknown) => { status?: number; body: unknown }>): {
  fetch: typeof fetch;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(typeof url === "string" ? url : url.toString());
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    const rawBody = init?.body;
    const parsedBody = typeof rawBody === "string" ? (JSON.parse(rawBody) as unknown) : null;
    requests.push({
      url: u.toString(),
      method: init?.method ?? "GET",
      authorization: headers.get("authorization") ?? "",
      body: rawBody !== undefined ? (rawBody as string) : null,
    });
    const key = `${init?.method ?? "GET"} ${u.pathname}`;
    const responder = routes[key] ?? routes[u.pathname];
    if (!responder) return new Response("not found", { status: 404 });
    const { status = 200, body } = responder(parsedBody);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetch: fn, requests };
}

describe("createCommitPublisher.getRef", () => {
  it("resolves the branch sha and sends Bearer auth", async () => {
    const { fetch, requests } = fakeFetch({
      "/repos/acme/widgets/git/ref/heads/feat": () => ({
        body: { object: { sha: "abc123" } },
      }),
    });
    const pub = createCommitPublisher({ owner: "acme", name: "widgets", getToken: async () => "ghs_tok", fetch });

    const sha = await pub.getRef("feat");
    expect(sha).toBe("abc123");
    expect(requests[0]?.authorization).toBe("Bearer ghs_tok");
  });

  it("throws CommitPublisherError on 404", async () => {
    const { fetch } = fakeFetch({});
    const pub = createCommitPublisher({ owner: "acme", name: "widgets", getToken: async () => "ghs_tok", fetch });

    await expect(pub.getRef("missing-branch")).rejects.toBeInstanceOf(CommitPublisherError);
  });

  it("never puts the token in the error message", async () => {
    const { fetch } = fakeFetch({});
    const pub = createCommitPublisher({ owner: "acme", name: "widgets", getToken: async () => "ghs_secret", fetch });

    try {
      await pub.getRef("missing");
    } catch (err) {
      expect((err as Error).message).not.toContain("ghs_secret");
    }
  });
});

describe("createCommitPublisher.createBranchRef", () => {
  it("posts to git/refs with the correct body", async () => {
    const { fetch, requests } = fakeFetch({
      "POST /repos/acme/widgets/git/refs": (body) => ({ body }),
    });
    const pub = createCommitPublisher({ owner: "acme", name: "widgets", getToken: async () => "ghs_tok", fetch });

    await pub.createBranchRef("feat", "deadbeef");

    const req = requests[0]!;
    expect(req.method).toBe("POST");
    const sent = JSON.parse(req.body!) as Record<string, string>;
    expect(sent.ref).toBe("refs/heads/feat");
    expect(sent.sha).toBe("deadbeef");
  });

  it("treats a 422 response (already exists) as success", async () => {
    const { fetch } = fakeFetch({
      "POST /repos/acme/widgets/git/refs": () => ({
        status: 422,
        body: { message: "Reference already exists" },
      }),
    });
    const pub = createCommitPublisher({ owner: "acme", name: "widgets", getToken: async () => "ghs_tok", fetch });

    await expect(pub.createBranchRef("existing", "sha")).resolves.toBeUndefined();
  });

  it("throws on non-422 errors", async () => {
    const { fetch } = fakeFetch({
      "POST /repos/acme/widgets/git/refs": () => ({ status: 500, body: { message: "server error" } }),
    });
    const pub = createCommitPublisher({ owner: "acme", name: "widgets", getToken: async () => "ghs_tok", fetch });

    await expect(pub.createBranchRef("feat", "sha")).rejects.toBeInstanceOf(CommitPublisherError);
  });

  it("throws on 422 with a non-idempotent message (e.g. invalid sha)", async () => {
    const { fetch } = fakeFetch({
      "POST /repos/acme/widgets/git/refs": () => ({
        status: 422,
        body: { message: "Object does not exist" },
      }),
    });
    const pub = createCommitPublisher({ owner: "acme", name: "widgets", getToken: async () => "ghs_tok", fetch });

    await expect(pub.createBranchRef("feat", "bad-sha")).rejects.toBeInstanceOf(CommitPublisherError);
  });
});

describe("createCommitPublisher.createCommitOnBranch", () => {
  it("sends the correct GraphQL mutation and returns the oid", async () => {
    const { fetch, requests } = fakeFetch({
      "POST /graphql": (_body) => {
        return {
          body: {
            data: {
              createCommitOnBranch: { commit: { oid: "newoid123" } },
            },
          },
        };
      },
    });
    const pub = createCommitPublisher({ owner: "acme", name: "widgets", getToken: async () => "ghs_tok", fetch });

    const oid = await pub.createCommitOnBranch({
      branchName: "feat",
      expectedHeadOid: "parentoid",
      headline: "feat: add greet",
      body: "add greeting function",
      fileChanges: { additions: [{ path: "src/greet.ts", contents: "aGVsbG8=" }], deletions: [] },
    });

    expect(oid).toBe("newoid123");

    const req = requests[0]!;
    const sent = JSON.parse(req.body!) as {
      variables: { input: { expectedHeadOid: string; message: { headline: string }; fileChanges: unknown } };
    };
    expect(sent.variables.input.expectedHeadOid).toBe("parentoid");
    expect(sent.variables.input.message.headline).toBe("feat: add greet");
    expect(sent.variables.input.fileChanges).toEqual({
      additions: [{ path: "src/greet.ts", contents: "aGVsbG8=" }],
      deletions: [],
    });
  });

  it("throws CommitPublisherError when GraphQL errors array is present", async () => {
    const { fetch } = fakeFetch({
      "POST /graphql": () => ({
        body: {
          data: null,
          errors: [{ message: "Could not resolve to a node" }],
        },
      }),
    });
    const pub = createCommitPublisher({ owner: "acme", name: "widgets", getToken: async () => "ghs_tok", fetch });

    await expect(
      pub.createCommitOnBranch({
        branchName: "feat",
        expectedHeadOid: "bad-oid",
        headline: "h",
        body: "b",
        fileChanges: { additions: [], deletions: [] },
      }),
    ).rejects.toBeInstanceOf(CommitPublisherError);
  });

  it("uses a fresh token per call", async () => {
    let callCount = 0;
    const tokens: string[] = [];
    const { fetch } = fakeFetch({
      "POST /graphql": () => ({
        body: { data: { createCommitOnBranch: { commit: { oid: "oid" } } } },
      }),
    });
    const wrappedFetch: typeof fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const h = new Headers(init?.headers as HeadersInit | undefined);
      tokens.push(h.get("authorization") ?? "");
      return (fetch as unknown as (u: typeof url, i?: RequestInit) => Promise<Response>)(url, init);
    }) as unknown as typeof fetch;

    callCount = 0;
    const pub = createCommitPublisher({
      owner: "acme",
      name: "widgets",
      getToken: async () => {
        callCount++;
        return `ghs_call${callCount}`;
      },
      fetch: wrappedFetch,
    });

    await pub.createCommitOnBranch({
      branchName: "feat",
      expectedHeadOid: "p",
      headline: "h",
      body: "b",
      fileChanges: { additions: [], deletions: [] },
    });
    await pub.createCommitOnBranch({
      branchName: "feat",
      expectedHeadOid: "p2",
      headline: "h2",
      body: "b2",
      fileChanges: { additions: [], deletions: [] },
    });

    expect(tokens[0]).toBe("Bearer ghs_call1");
    expect(tokens[1]).toBe("Bearer ghs_call2");
  });
});

describe("createCommitPublisher.createPullRequest", () => {
  it("posts to /pulls and maps html_url to url", async () => {
    const { fetch, requests } = fakeFetch({
      "POST /repos/acme/widgets/pulls": () => ({
        body: { number: 42, html_url: "https://github.com/acme/widgets/pull/42" },
      }),
    });
    const pub = createCommitPublisher({ owner: "acme", name: "widgets", getToken: async () => "ghs_tok", fetch });

    const pr = await pub.createPullRequest({ base: "main", head: "feat", title: "Add greet", body: "body text" });

    expect(pr.number).toBe(42);
    expect(pr.url).toBe("https://github.com/acme/widgets/pull/42");

    const req = requests[0]!;
    const sent = JSON.parse(req.body!) as Record<string, string>;
    expect(sent.base).toBe("main");
    expect(sent.head).toBe("feat");
    expect(sent.title).toBe("Add greet");
  });

  it("throws on a non-2xx response", async () => {
    const { fetch } = fakeFetch({
      "POST /repos/acme/widgets/pulls": () => ({ status: 422, body: { message: "Validation Failed" } }),
    });
    const pub = createCommitPublisher({ owner: "acme", name: "widgets", getToken: async () => "ghs_tok", fetch });

    await expect(pub.createPullRequest({ base: "main", head: "feat", title: "T", body: "B" })).rejects.toBeInstanceOf(
      CommitPublisherError,
    );
  });
});
