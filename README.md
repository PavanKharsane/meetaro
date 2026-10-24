# Meetaro

Meetaro is a local travel marketplace where travellers can request accommodation, regional food, and local experiences from hosts. Host applications stay private until an administrator records the required review checks.

## Run locally

Requirements: Node.js 22 or newer.

```sh
npm ci
npm start
```

Open <http://localhost:3000>. The app uses the existing Node.js, Express, bcrypt, and JSON-file conventions in this repository. It does not require a database server for local development.

Copy `.env.example` to `.env` and set a unique `JWT_SECRET` (at least 32 characters). Configure the Zoho SMTP variables with an app-specific mailbox password to enable registration verification, greeting emails, and new host application alerts to `HOST_APPLICATION_NOTIFY_EMAIL` (defaults to `meetaro@zohomail.in`). The default SMTP host is `smtp.zoho.in`; use the host Zoho specifies for your account region if different. To use administrator review tools, configure both `ADMIN_EMAIL` and `ADMIN_PASSWORD`; the password must be 16–128 characters. The configured email is provisioned as an administrator at startup and cannot be the email of a traveller account. Restarting with the same admin email updates its password from the environment. Keep `.env` private and never commit real credentials.

## Architecture and data model

The current implementation deliberately keeps the existing stack rather than migrating frameworks:

- **Web/API:** Express routes in `server.js` and the travel domain routes in `travel.js`.
- **Authentication:** bcrypt password hashes and seven-day JWT bearer tokens. New traveller registrations require a six-digit email code before the account is created; codes expire after 10 minutes and are stored as HMAC hashes. A greeting email is sent after verification. Administrator accounts are created from environment configuration; host accounts are promoted only after administrator approval.
- **Persistence:** `data.json`, with collections for users, host applications, travel bookings, reviews, reports, and audit events. Writes are synchronous and booking transitions validate availability on the server.
- **UI:** Accessible responsive HTML/CSS and browser JavaScript in `public/index.html`.

| Collection | Purpose |
|---|---|
| `users` | Login identity and `traveller`, `host_applicant`, `host`, `host_suspended`, or `admin` role |
| `hostApplications` | Public profile and service offer, private contact/address, review status, verification outcomes |
| `travelBookings` | Traveller request, dates, selected services, price estimate, consent, and booking status |
| `travelReviews` | One review per completed booking |
| `travelReports` | Traveller/host concerns and administrator resolution |
| `travelAudit` | Timestamped host-review, booking, and report actions |

For production, migrate the JSON collections to PostgreSQL with migrations and transactions; use private object storage for verification records; configure HTTPS, session/token rotation, booking notification emails, a payment provider, backups, monitoring, and a documented retention/deletion policy. JSON storage is a development database, not a multi-instance production datastore.

## Implemented workflows

- Traveller signup with email OTP verification, login, greeting email after verification, and public search by destination, service, budget, and optional host gender.
- Host applications for accommodation, food, local exploration, or combinations. Private legal name, phone, and exact accommodation address are not part of public search results.
- A new host application triggers an email to the configured review inbox with the subject “The New Host has been registered”. It includes only the public name, city, and application reference; the application remains pending manual review.
- Administrator-only application review and audit history. A host cannot be approved until the administrator explicitly records identity and property checks as passed and the interview as completed. The UI does not represent approval as a safety guarantee.
- Booking estimates for nights, guest-count meals, and experience hours, with explicit gender-preference mismatch consent.
- Host acceptance/decline followed by traveller confirmation. The server validates dates and prevents overlapping confirmed bookings. The exact accommodation address is released to the traveller only after confirmation.
- Host completion, post-completion traveller reviews, booking reports, and administrator report resolution.

## Administrator review

1. Set `ADMIN_EMAIL` and `ADMIN_PASSWORD` in `.env` and start the server.
2. Log in from the Meetaro page with those credentials.
3. Open **Admin** to review host applications. Contact and property details are visible only in this protected area.
4. Do not select the identity/property/interview completion checks unless the relevant review has actually taken place. Meetaro currently does not collect or store verification documents or schedule video interviews.

## Current limitations — not production-ready

- The data store is a local JSON file. It has no cross-process transaction or concurrency guarantees.
- Secure identity/property document upload, access-controlled object storage, live verification interviews, and booking notifications are not integrated. Registration OTP, greeting emails, and host-application alerts use the configured Zoho-compatible SMTP account.
- Payments, refunds, taxes, platform fees, messaging, maps, third-party social sign-in, emergency support, advanced availability calendars, cancellation automation, and complete legal-policy pages are not integrated. No payment is taken.
- Listings use original CSS illustrations rather than uploaded host photographs. There is no sample host dataset or fabricated rating/verification data.
- Admin application review records the administrator's explicit outcomes and notes; it does not itself perform an identity or property check.

Do not launch with real bookings or sensitive verification data until the limitations above are addressed and the system is migrated to a production-grade datastore and private storage.

## Tests

```sh
npm test
```

The end-to-end test runs an isolated app instance and covers account roles, private host submission, administrator review, listing privacy, consent, price calculation, booking confirmation, address disclosure, double-booking prevention, completion, reviews, reports, and audit events.

## GitHub Actions

CI runs on pushes and pull requests targeting `main` and can be started manually. It checks Node.js and browser-script syntax, runs the travel workflow tests, smoke-tests the HTTP app and protected API, and audits production dependencies. Automatic deployment is not configured.
