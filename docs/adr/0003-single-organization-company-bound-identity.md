# Microsoft login for one organization

**Status: accepted.** Each Portifact deployment serves one Organization and authenticates normal production users through that Organization's Microsoft Entra tenant. The MVP uses Microsoft login only, keeps public registration and normal password login disabled, and treats local password access as an explicitly controlled development or recovery path.

This keeps the MVP small and makes the company's tenant identity, rather than an email suffix, the security boundary. Open-source installations can configure their own Organization without requiring SaaS multi-tenancy.

## Consequences

- A user must be associated with the configured Organization before receiving internal access.
- Public registration is not part of the MVP login flow.
- Production recovery must be designed explicitly because ordinary password login is not available.
