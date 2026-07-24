# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: x.spec.mjs >> x
- Location: ../../tmp/nyabase-context-probe-eJt7aJ/x.spec.mjs:1:124

# Error details

```
Error: expect(locator).toContainText(expected) failed

Locator: locator('main')
Expected substring: "absent"
Received string:    "Password visible-nyabase-context-probe-eJt7aJ-value"
Timeout: 50ms

Call log:
  - Expect "toContainText" with timeout 50ms
  - waiting for locator('main')
    29 × locator resolved to <main>…</main>
       - unexpected value "Password visible-nyabase-context-probe-eJt7aJ-value"

```

```yaml
- main:
  - text: Password
  - textbox "Password": input-nyabase-context-probe-eJt7aJ-value
  - paragraph: visible-nyabase-context-probe-eJt7aJ-value
```

# Test source

```ts
> 1 | import{test,expect}from "/root/nyabase/node_modules/.pnpm/@playwright+test@1.60.0/node_modules/@playwright/test/index.mjs";test("x",async({page})=>{await page.setContent("<main><label>Password <input type=\"password\" value=\"input-nyabase-context-probe-eJt7aJ-value\"></label><p>visible-nyabase-context-probe-eJt7aJ-value</p></main>");await expect(page.locator("main")).toContainText("absent",{timeout:50})});
    |                                                                                                                                                                                                                                                                                                                                                                                    ^ Error: expect(locator).toContainText(expected) failed
```