# Clearance Queueing System

An MVP clearance queue with an Astro/Tailwind web app, Express API, MongoDB persistence, secure staff/admin sessions, and Socket.IO updates. Students join without accounts; one shared QR code always points to `/join`.

## Requirements

- Node.js 22.23.4 or newer (required by the current Astro release)
- A MongoDB Atlas database (or another MongoDB deployment)

## Local setup

1. Install dependencies:

   ```sh
   npm install
   ```

2. Copy `.env.example` to `.env` and set `MONGODB_URI`, a random `SESSION_SECRET` of at least 32 characters, and the admin and staff names, emails, and passwords. Use passwords of at least 12 characters.
3. Ensure the database is reachable from your machine in Atlas Network Access.
4. Create the initial administrator, then start the Astro and API development servers:

   ```sh
   npm run seed:accounts
   npm run dev
   ```

   The student app is at `http://localhost:4321`, and the API is at `http://localhost:3001`. `seed:accounts` creates one admin and one staff account from environment variables. `seed:admin` creates only the admin. Existing matching accounts are left unchanged; additional staff accounts can be created from the admin dashboard.

The local admin username is the part of `ADMIN_EMAIL` before `@`; either it or the full email can be used to sign in.

If your Node.js runtime cannot resolve Atlas SRV records through the system DNS resolver, optionally set `MONGODB_DNS_SERVERS` to a comma-separated list of DNS server IPs approved for your environment. It is unset by default, so Node uses the system resolver.

## Production

Set `NODE_ENV=production`, `PUBLIC_APP_URL` to the canonical HTTPS origin where this app will be hosted, and `PUBLIC_API_URL` if the API is on a different origin. Configure a strong `SESSION_SECRET`, MongoDB Atlas credentials, and trusted proxy/HTTPS settings for the hosting platform.

```sh
npm run build
npm start
```

In production Express serves the generated Astro site and API from the same process. For split-origin hosting, configure the API URL, HTTPS, and matching CORS origin. Cookies are HTTP-only and secure in production. Never commit `.env` or put MongoDB credentials in frontend variables.

## Permanent student QR

Visit `/qr` and print the single QR code. It encodes `${PUBLIC_APP_URL}/join`; it is not generated per student or ticket. Set `PUBLIC_APP_URL` to the permanent school domain before printing and keep that route available.

## Route access

- `/` is the staff/admin sign-in page. `/join` is the public student registration page.
- `/join` is public and contains no staff/admin links. It shows only queue status, accepts a numeric student ID with optional hyphens, and validates joins on the server. Hyphens are removed before duplicate checking.
- Sign-in is at `/`; sign-in redirects by account role. The old `/login` URL redirects to `/`.
- Staff can use **Forgot password?** to get instructions for requesting a temporary password from an administrator. Admins can issue or reset staff temporary passwords in Staff Accounts; staff must change them at next sign-in.
- Staff/admin sessions persist across browser restarts and roll forward while active, with a one-year idle expiry. Logging out clears the session.
- `/staff/dashboard` and `/staff/history` are available to staff and admins. `/admin/dashboard`, `/admin/staff`, `/admin/settings`, `/admin/history`, and `/qr` are admin-only.
- `/account` lets signed-in staff and admins update their email address and password after confirming their current password.
- Express protects production dashboard routes and API endpoints. The Astro dev/preview middleware checks the API session before serving protected dashboard pages.

Staff/admin sockets join `staff-room` and receive full dashboard queue data. Unauthenticated sockets join `student-room` and receive only queue open/closed state, waiting count, current queue number, and individual position data after watching their ticket. Queue-management socket events are rejected unless the socket belongs to `staff-room`.

## Queue and data behavior

- MongoDB indexes enforce unique daily queue numbers, one active ticket per student per day, and one currently serving ticket. A MongoDB atomic counter assigns each daily sequence; queue numbers restart at `Q001` on the next date in `QUEUE_TIME_ZONE` (default `Asia/Manila`).
- Completed and No Show tickets remain in the database and history. Students may join again that day after a terminal status.
- The server persists `callExpiresAt`, processes expired calls in the background, and checks expiry when queue operations/status are requested. A restart does not reset a call timer.
- Admins can pause new ticket registrations and configure the call timeout from Queue Settings.
- Students can return to an active ticket using the ticket URL or browser storage. The UUID ticket URL exposes only that ticket's status details; other students are never listed by public endpoints.
- Waiting estimates use a simple five-minute-per-person approximation. Adjust that constant in `src/scripts/app.js` if school service-time observations call for a different estimate.
- Admin queue reset marks today's active tickets as No Show and retains the daily counter and historical records to prevent duplicate queue numbers.

## Checks

```sh
npm run check
npm run build
```
