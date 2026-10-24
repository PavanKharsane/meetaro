const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { test } = require('node:test');

const projectRoot = path.resolve(__dirname, '..');

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const { port } = probe.address();
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function startSmtpCapture() {
  const messages = [];
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    socket.write('220 localhost ESMTP\r\n');
    const lines = readline.createInterface({ input: socket });
    let collectingMessage = false;
    let authStage = '';
    let messageLines = [];
    lines.on('line', (line) => {
      if (collectingMessage) {
        if (line === '.') {
          collectingMessage = false;
          messages.push(messageLines.join('\n'));
          messageLines = [];
          socket.write('250 Message accepted\r\n');
        } else {
          messageLines.push(line.startsWith('..') ? line.slice(1) : line);
        }
      } else if (authStage === 'username') {
        authStage = 'password';
        socket.write('334 UGFzc3dvcmQ6\r\n');
      } else if (authStage === 'password') {
        authStage = '';
        socket.write('235 Authentication successful\r\n');
      } else if (/^EHLO|^HELO/i.test(line)) {
        socket.write('250-localhost\r\n250-AUTH PLAIN LOGIN\r\n250 SIZE 10485760\r\n');
      } else if (/^AUTH PLAIN /i.test(line)) {
        socket.write('235 Authentication successful\r\n');
      } else if (/^AUTH LOGIN/i.test(line)) {
        authStage = 'username';
        socket.write('334 VXNlcm5hbWU6\r\n');
      } else if (/^(MAIL FROM|RCPT TO)/i.test(line)) {
        socket.write('250 OK\r\n');
      } else if (/^DATA$/i.test(line)) {
        collectingMessage = true;
        socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
      } else if (/^QUIT$/i.test(line)) {
        socket.write('221 Bye\r\n');
        socket.end();
      } else {
        socket.write('250 OK\r\n');
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { server, port: server.address().port, messages };
}

function dateAfter(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

test('travel host approval, private listing, booking consent, confirmation, and review', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meetaro-travel-test-'));
  const smtp = await startSmtpCapture();
  let appServer;
  try {
    fs.copyFileSync(path.join(projectRoot, 'server.js'), path.join(tempDir, 'server.js'));
    fs.copyFileSync(path.join(projectRoot, 'travel.js'), path.join(tempDir, 'travel.js'));
    fs.cpSync(path.join(projectRoot, 'public'), path.join(tempDir, 'public'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'data.json'), JSON.stringify({ users: [], likes: [], matches: [], messages: [] }));
    const port = await freePort();
    appServer = spawn(process.execPath, ['server.js'], {
      cwd: tempDir,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PORT: String(port),
        NODE_PATH: path.join(projectRoot, 'node_modules'),
        JWT_SECRET: 'isolated-travel-test-jwt-secret-32-characters',
        ADMIN_EMAIL: 'admin@meetaro.example',
        ADMIN_PASSWORD: 'Travel-admin-test-password-2026',
        SMTP_HOST: '127.0.0.1',
        SMTP_PORT: String(smtp.port),
        SMTP_SECURE: 'false',
        SMTP_USER: 'test-user',
        SMTP_PASSWORD: 'test-password',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    appServer.stderr.setEncoding('utf8');
    appServer.stderr.on('data', (chunk) => { stderr += chunk; });
    const baseUrl = `http://127.0.0.1:${port}`;
    let started = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      if (appServer.exitCode !== null) throw new Error(`App exited during startup: ${stderr}`);
      try {
        if ((await fetch(baseUrl)).ok) {
          started = true;
          break;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(started, `App did not start: ${stderr}`);

    async function request(route, token, method = 'GET', body) {
      const response = await fetch(baseUrl + route, {
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await response.json();
      return { response, data };
    }
    async function signup(name, email) {
      const signupResponse = await request('/api/signup', null, 'POST', {
        name, email, password: 'Travel-test-password-123', age: 30, gender: 'Woman',
      });
      assert.equal(signupResponse.response.status, 202);
      assert.equal(signupResponse.data.token, undefined);
      assert.equal((await request('/api/signup', null, 'POST', {
        name, email, password: 'Travel-test-password-123', age: 30, gender: 'Woman',
      })).response.status, 202, 'a pending registration can resume OTP verification');
      assert.equal((await request('/api/login', null, 'POST', {
        email, password: 'Travel-test-password-123',
      })).response.status, 400, 'unverified account cannot log in');
      const verificationMessage = smtp.messages.find((message) =>
        message.includes(`To: ${email}`) && message.includes('Your Meetaro verification code'),
      );
      assert.ok(verificationMessage, 'verification code email was delivered');
      assert.match(verificationMessage, /^From:.*meetaro@zohomail\.in/im);
      const code = /Your Meetaro verification code is: (\d{6})/.exec(verificationMessage)?.[1];
      assert.ok(code, 'verification code is present in the email');
      assert.equal((await request('/api/signup/resend', null, 'POST', { email })).response.status, 429);
      const incorrectCode = code === '000000' ? '111111' : '000000';
      assert.equal((await request('/api/signup/verify', null, 'POST', { email, code: incorrectCode })).response.status, 400);
      const verified = await request('/api/signup/verify', null, 'POST', { email, code });
      assert.equal(verified.response.status, 201);
      assert.equal(verified.data.user.role, 'traveller');
      assert.equal(verified.data.user.emailVerified, undefined, 'verification internals are not exposed');
      const welcomeMessage = smtp.messages.find((message) =>
        message.includes(`To: ${email}`) && message.includes('Welcome to Meetaro'),
      );
      assert.ok(welcomeMessage, 'greeting email is sent after verification');
      assert.match(welcomeMessage, /^From:.*meetaro@zohomail\.in/im);
      assert.match(welcomeMessage, /Questions or concerns\? Email/i);
      assert.match(welcomeMessage, /mailto:meetaro@zohomail\.in/i);
      return verified.data.token;
    }

    const listingResponse = await request('/api/travel/listings');
    assert.equal(listingResponse.response.status, 200);
    assert.deepEqual(listingResponse.data, []);
    assert.equal((await request('/api/admin/overview')).response.status, 401);

    const travellerToken = await signup('Priya Sharma', 'priya@traveller.example');
    const hostToken = await signup('Asha Host', 'asha@host.example');
    const applicationBody = {
      legalName: 'Asha Private Legal Name',
      phone: '+91 90000 11111',
      publicName: 'Asha',
      city: 'Pune',
      area: 'Koregaon Park',
      gender: 'Man',
      languages: ['English', 'Hindi', 'Marathi'],
      introduction: 'Local food, thoughtful walks, and a private guest room.',
      availabilityFrom: dateAfter(2),
      availabilityTo: dateAfter(60),
      policyAccepted: true,
      services: {
        accommodation: {
          enabled: true,
          pricePerNight: 2000,
          propertyType: 'Private room in occupied home',
          capacity: 4,
          amenities: ['Wi-Fi', 'Breakfast'],
          houseRules: 'No smoking indoors.',
          hostLivesOnsite: true,
          propertyAddress: 'PRIVATE TEST ADDRESS, NEVER PUBLIC BEFORE CONFIRMATION',
        },
        food: { enabled: true, pricePerMeal: 350, menu: 'Sample Maharashtrian home-cooked meal', dietaryOptions: 'Vegetarian available', allergens: 'Ask before booking' },
        exploration: { enabled: true, pricePerHour: 500, experiences: 'Old city walk and local market visit' },
      },
    };
    const submitted = await request('/api/travel/host/applications', hostToken, 'POST', applicationBody);
    assert.equal(submitted.response.status, 201);
    assert.equal(submitted.data.status, 'submitted');
    const hostNotification = smtp.messages.find((message) =>
      message.includes('To: meetaro@zohomail.in') && message.includes('Subject: The New Host has been registered'),
    );
    assert.ok(hostNotification, 'admin inbox receives a new host application alert');
    assert.match(hostNotification, /^From:.*meetaro@zohomail\.in/im);
    assert.match(hostNotification, /Public name: Asha/);
    assert.match(hostNotification, /City: Pune/);
    assert.match(hostNotification, new RegExp(`Application ID: ${submitted.data.id}`));
    assert.equal(hostNotification.includes('Asha Private Legal Name'), false, 'admin notification omits the legal name');
    assert.equal(hostNotification.includes('+91 90000 11111'), false, 'admin notification omits the phone');
    assert.equal(hostNotification.includes('PRIVATE TEST ADDRESS'), false, 'admin notification omits the property address');
    assert.equal((await request('/api/travel/listings')).data.length, 0, 'unapproved host is not public');
    assert.equal((await request('/api/admin/applications', travellerToken)).response.status, 403);

    const adminLogin = await request('/api/login', null, 'POST', {
      email: 'admin@meetaro.example',
      password: 'Travel-admin-test-password-2026',
    });
    assert.equal(adminLogin.response.status, 200);
    assert.equal(adminLogin.data.user.role, 'admin');
    const adminToken = adminLogin.data.token;
    const applications = await request('/api/admin/applications', adminToken);
    assert.equal(applications.response.status, 200);
    const application = applications.data[0];
    assert.equal(application.phone, '+91 90000 11111');
    const invalidApproval = await request(`/api/admin/applications/${application.id}/review`, adminToken, 'POST', {
      status: 'approved',
      verification: { identity: 'passed', property: 'passed', interview: 'scheduled' },
    });
    assert.equal(invalidApproval.response.status, 400, 'incomplete checks cannot approve a host');

    const approved = await request(`/api/admin/applications/${application.id}/review`, adminToken, 'POST', {
      status: 'approved',
      notes: 'Checks completed by the authorized reviewer.',
      verification: { identity: 'passed', property: 'passed', interview: 'completed' },
    });
    assert.equal(approved.response.status, 200);
    assert.equal(approved.data.status, 'approved');

    const listings = await request('/api/travel/listings?city=pune&service=accommodation');
    assert.equal(listings.response.status, 200);
    assert.equal(listings.data.length, 1);
    assert.equal(listings.data[0].host.name, 'Asha');
    const publicListing = JSON.stringify(listings.data[0]);
    assert.equal(publicListing.includes('+91 90000 11111'), false);
    assert.equal(publicListing.includes('Asha Private Legal Name'), false);
    assert.equal(publicListing.includes('PRIVATE TEST ADDRESS'), false);
    assert.equal(publicListing.includes('asha@host.example'), false);

    const dates = { arrivalDate: dateAfter(3), departureDate: dateAfter(5) };
    const dateFiltered = await request(`/api/travel/listings?city=Pune&arrivalDate=${dates.arrivalDate}&departureDate=${dates.departureDate}&travellers=3&service=accommodation`);
    assert.equal(dateFiltered.data.length, 1);
    assert.equal((await request(`/api/travel/listings?arrivalDate=${dateAfter(61)}&departureDate=${dateAfter(63)}`)).data.length, 0);
    const savedHost = await request(`/api/travel/favorites/${application.id}`, travellerToken, 'PUT', {});
    assert.equal(savedHost.response.status, 200);
    assert.equal(savedHost.data.saved, true);
    assert.equal((await request('/api/travel/favorites', travellerToken)).data.length, 1);
    const bookingBody = {
      listingId: application.id,
      ...dates,
      travellers: 2,
      services: ['accommodation', 'food', 'exploration'],
      mealCount: 2,
      explorationHours: 3,
      genderPreference: 'woman',
      foodPreferences: 'Vegetarian meals, please.',
      introduction: 'We are visiting Pune for a weekend.',
    };
    const missingConsent = await request('/api/travel/bookings', travellerToken, 'POST', bookingBody);
    assert.equal(missingConsent.response.status, 409);
    assert.equal(missingConsent.data.consentRequired, true);
    const bookingRequest = await request('/api/travel/bookings', travellerToken, 'POST', {
      ...bookingBody, consentToPreferenceMismatch: true,
    });
    assert.equal(bookingRequest.response.status, 201);
    assert.equal(bookingRequest.data.status, 'pending');
    assert.equal(bookingRequest.data.estimate.total, 6900);
    assert.equal(JSON.stringify(bookingRequest.data).includes('PRIVATE TEST ADDRESS'), false);
    assert.equal((await request('/api/travel/bookings', hostToken, 'POST', bookingBody)).response.status, 403);

    const hostDashboard = await request('/api/travel/host/dashboard', hostToken);
    assert.equal(hostDashboard.response.status, 200);
    assert.equal(hostDashboard.data.bookings[0].traveller.name, 'Priya');
    assert.equal(JSON.stringify(hostDashboard.data.bookings[0]).includes('priya@traveller.example'), false);
    assert.equal(JSON.stringify(hostDashboard.data.bookings[0]).includes('PRIVATE TEST ADDRESS'), false);

    const hostAccept = await request(`/api/travel/bookings/${bookingRequest.data.id}/host-response`, hostToken, 'POST', {
      decision: 'accept',
      proposedTotal: 7200,
    });
    assert.equal(hostAccept.response.status, 200);
    assert.equal(hostAccept.data.status, 'awaiting_traveller_confirmation');
    assert.equal(hostAccept.data.proposedTotal, 7200);
    assert.equal(hostAccept.data.host, undefined);

    const confirmed = await request(`/api/travel/bookings/${bookingRequest.data.id}/confirm`, travellerToken, 'POST', {});
    assert.equal(confirmed.response.status, 200);
    assert.equal(confirmed.data.status, 'confirmed');
    assert.equal(confirmed.data.host.arrivalAddress, 'PRIVATE TEST ADDRESS, NEVER PUBLIC BEFORE CONFIRMATION');

    const overlap = await request('/api/travel/bookings', travellerToken, 'POST', {
      ...bookingBody, consentToPreferenceMismatch: true,
    });
    assert.equal(overlap.response.status, 409, 'confirmed dates cannot be double booked');

    const completed = await request(`/api/travel/bookings/${bookingRequest.data.id}/complete`, hostToken, 'POST', {});
    assert.equal(completed.response.status, 200);
    assert.equal(completed.data.status, 'completed');
    const review = await request(`/api/travel/bookings/${bookingRequest.data.id}/reviews`, travellerToken, 'POST', {
      rating: 5, comment: 'A welcoming local experience.',
    });
    assert.equal(review.response.status, 201);
    assert.equal((await request(`/api/travel/bookings/${bookingRequest.data.id}/reviews`, travellerToken, 'POST', { rating: 5, comment: 'Duplicate' })).response.status, 409);
    const publicReviews = await request(`/api/travel/listings/${application.id}/reviews`);
    assert.equal(publicReviews.data.length, 1);
    assert.equal(publicReviews.data[0].rating, 5);

    const report = await request('/api/travel/reports', travellerToken, 'POST', {
      bookingId: bookingRequest.data.id, reason: 'Sample report for the test.',
    });
    assert.equal(report.response.status, 201);
    assert.equal((await request('/api/admin/reports', adminToken)).data.length, 1);
    const overview = await request('/api/admin/overview', adminToken);
    assert.equal(overview.data.approvedHosts, 1);
    assert.equal(overview.data.bookings, 1);
    assert.ok((await request('/api/admin/audit', adminToken)).data.length >= 5);
  } finally {
    if (appServer && appServer.exitCode === null) {
      appServer.kill('SIGTERM');
      await once(appServer, 'exit');
    }
    await new Promise((resolve, reject) => smtp.server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
