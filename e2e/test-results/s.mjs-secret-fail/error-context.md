# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: s.mjs >> secret fail
- Location: ../../../tmp/nyabase-cycle12-env-reporter-oYWaJz/s.mjs:1:124

# Error details

```
Error: expect(locator).toContainText(expected) failed

Locator: locator('main')
Expected substring: "absent"
Received string:    "dom-nyabase-cycle12-env-reporter-oYWaJz-secret"
Timeout: 50ms

Call log:
  - Expect "toContainText" with timeout 50ms
  - waiting for locator('main')
    30 × locator resolved to <main>…</main>
       - unexpected value "dom-nyabase-cycle12-env-reporter-oYWaJz-secret"
 throw-nyabase-cycle12-env-reporter-oYWaJz-secret password="cred-nyabase-cycle12-env-reporter-oYWaJz-secret"
```

```yaml
- main:
  - textbox: dom-nyabase-cycle12-env-reporter-oYWaJz-secret
  - paragraph: dom-nyabase-cycle12-env-reporter-oYWaJz-secret
```

# Test source

```ts
> 1 | import{test,expect}from "/root/nyabase/node_modules/.pnpm/@playwright+test@1.60.0/node_modules/@playwright/test/index.mjs";test("secret fail",async({page})=>{await page.setContent("<main><input type=\"password\" value=\"dom-nyabase-cycle12-env-reporter-oYWaJz-secret\"><p>dom-nyabase-cycle12-env-reporter-oYWaJz-secret</p></main>");try{await expect(page.locator("main")).toContainText("absent",{timeout:50})}catch(e){e.message+=" throw-nyabase-cycle12-env-reporter-oYWaJz-secret password=\"cred-nyabase-cycle12-env-reporter-oYWaJz-secret\"";throw e}});
    |                                                                                                                                                                                                                                                                                                                                                                                    ^ Error: expect(locator).toContainText(expected) failed
```