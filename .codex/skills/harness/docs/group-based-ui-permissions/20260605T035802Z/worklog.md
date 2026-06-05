# Worklog

- Read harness workflow and PM role.
- Searched backend/frontend permission paths.
- Found frontend route/nav guards already consume user.capabilities.
- Found backend capabilities guard already consumes AccessResolver.userCapabilities.
- Candidate issue: initial admin user is automatically added to Administrators system group whose capabilities include all capabilities.
