const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const HOST_STATUSES = new Set([
  'under_review', 'contact_required', 'interview_scheduled', 'verification_pending',
  'approved', 'rejected', 'suspended',
]);
const SERVICE_NAMES = new Set(['accommodation', 'food', 'exploration']);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cleanText(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function positivePrice(value, label) {
  const price = Number(value);
  if (!Number.isInteger(price) || price < 1 || price > 10000000) {
    throw new Error(`${label} must be a whole number between ₹1 and ₹10,000,000.`);
  }
  return price;
}

function parseDate(value, label) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) throw new Error(`Enter a valid ${label}.`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`Enter a valid ${label}.`);
  }
  return value;
}

function publicServices(services) {
  const result = {};
  for (const name of SERVICE_NAMES) {
    if (!services[name]?.enabled) continue;
    const { enabled, propertyAddress, ...details } = services[name];
    result[name] = details;
  }
  return result;
}

function publicHost(application) {
  const { id, userId, publicName, city, area, gender, languages, introduction, services,
    availabilityFrom, availabilityTo, approvedAt } = application;
  return {
    id,
    host: { name: publicName, city, area, gender, languages, introduction },
    services: publicServices(services),
    availability: { from: availabilityFrom, to: availabilityTo },
    approvedAt,
  };
}

function overlaps(startA, endA, startB, endB) {
  return startA < endB && startB < endA;
}

function registerTravelRoutes({ app, db, save, newId, auth, limit, jwtSecret, sendHostApplicationNotification }) {
  db.hostApplications ||= [];
  db.travelBookings ||= [];
  db.travelReviews ||= [];
  db.travelReports ||= [];
  db.travelAudit ||= [];

  const requireRole = (...roles) => (req, res, next) => {
    if (!roles.includes(req.user.role || 'traveller')) return res.status(403).json({ error: 'This action is not available for your account.' });
    next();
  };
  const requireAdmin = [auth, requireRole('admin')];
  const recordAudit = (actorId, action, targetId) => {
    db.travelAudit.push({ id: newId(), actorId, action, targetId, at: Date.now() });
    db.travelAudit = db.travelAudit.slice(-10000);
  };
  const applicationForUser = (userId) => db.hostApplications.find((item) => item.userId === userId);
  const applicationForId = (id) => db.hostApplications.find((item) => item.id === id);
  const listingForId = (id) => {
    const application = applicationForId(id);
    return application?.status === 'approved' ? application : null;
  };
  const bookingForUser = (id, user) => {
    const booking = db.travelBookings.find((item) => item.id === id);
    if (!booking) return null;
    const application = applicationForId(booking.listingId);
    return booking.travellerId === user.id || application?.userId === user.id ? { booking, application } : null;
  };
  const bookingConflict = (listingId, arrival, departure, ignoreBookingId) =>
    db.travelBookings.some((booking) => booking.listingId === listingId &&
      booking.id !== ignoreBookingId && ['confirmed', 'in_progress'].includes(booking.status) &&
      overlaps(arrival, departure, booking.arrivalDate, booking.departureDate));
  const bookingView = (booking, viewer, application) => {
    const shared = {
      id: booking.id,
      status: booking.status,
      arrivalDate: booking.arrivalDate,
      departureDate: booking.departureDate,
      nights: booking.nights,
      travellers: booking.travellers,
      services: booking.services,
      mealCount: booking.mealCount,
      explorationHours: booking.explorationHours,
      foodPreferences: booking.foodPreferences,
      introduction: booking.introduction,
      estimate: booking.estimate,
      proposedTotal: booking.proposedTotal,
      createdAt: booking.createdAt,
      updatedAt: booking.updatedAt,
      cancellationPolicy: 'Contact the host through Meetaro before your stay to request a change or cancellation.',
    };
    if (viewer.role === 'admin') {
      return { ...shared, travellerId: booking.travellerId, hostId: booking.hostId, listingId: booking.listingId, genderPreference: booking.genderPreference, consentedToMismatch: booking.consentedToMismatch };
    }
    if (viewer.id === booking.travellerId) {
      return {
        ...shared,
        host: {
          name: application.publicName,
          city: application.city,
          area: application.area,
          ...(booking.status === 'confirmed' && booking.services.includes('accommodation')
            ? { arrivalAddress: application.services.accommodation.propertyAddress }
            : {}),
        },
      };
    }
    const traveller = db.users.find((user) => user.id === booking.travellerId);
    return { ...shared, traveller: { name: booking.travellerName, gender: traveller?.gender || 'Not shared' } };
  };

  app.get('/api/travel/listings', limit(120, 60 * 60 * 1000), (req, res) => {
    const city = cleanText(req.query.city, 80).toLocaleLowerCase();
    const query = cleanText(req.query.q, 80).toLocaleLowerCase();
    const service = cleanText(req.query.service, 30);
    const gender = cleanText(req.query.hostGender, 20).toLocaleLowerCase();
    const maxBudget = req.query.maxBudget === undefined ? null : Number(req.query.maxBudget);
    const arrivalDate = req.query.arrivalDate === undefined ? null : req.query.arrivalDate;
    const departureDate = req.query.departureDate === undefined ? null : req.query.departureDate;
    const travellers = req.query.travellers === undefined ? null : Number(req.query.travellers);
    if (service && !SERVICE_NAMES.has(service)) return res.status(400).json({ error: 'Choose a valid service filter.' });
    if (maxBudget !== null && (!Number.isFinite(maxBudget) || maxBudget < 0)) return res.status(400).json({ error: 'Enter a valid budget.' });
    if ((arrivalDate === null) !== (departureDate === null)) return res.status(400).json({ error: 'Enter both arrival and departure dates.' });
    if (arrivalDate !== null) {
      try {
        parseDate(arrivalDate, 'arrival date');
        parseDate(departureDate, 'departure date');
      } catch (error) {
        return res.status(400).json({ error: error.message });
      }
      if (departureDate <= arrivalDate) return res.status(400).json({ error: 'Departure must be after arrival.' });
    }
    if (travellers !== null && (!Number.isInteger(travellers) || travellers < 1 || travellers > 12)) {
      return res.status(400).json({ error: 'Choose between 1 and 12 travellers.' });
    }
    const listings = db.hostApplications
      .filter((application) => application.status === 'approved')
      .filter((application) => !city || application.city.toLocaleLowerCase().includes(city))
      .filter((application) => !gender || gender === 'any' || application.gender.toLocaleLowerCase() === gender)
      .filter((application) => !arrivalDate || (
        application.availabilityFrom <= arrivalDate && application.availabilityTo >= departureDate
      ))
      .filter((application) => !travellers || service !== 'accommodation' ||
        application.services.accommodation?.capacity >= travellers)
      .filter((application) => !query || [
        application.publicName, application.city, application.area, application.introduction,
        ...application.languages, ...Object.values(publicServices(application.services)).flatMap((value) => Object.values(value).filter((item) => typeof item === 'string')),
      ].join(' ').toLocaleLowerCase().includes(query))
      .filter((application) => !service || application.services[service]?.enabled)
      .filter((application) => maxBudget === null || Object.entries(application.services)
        .some(([name, details]) => details.enabled && (
          (name === 'accommodation' && details.pricePerNight <= maxBudget) ||
          (name === 'food' && details.pricePerMeal <= maxBudget) ||
          (name === 'exploration' && details.pricePerHour <= maxBudget)
        )))
      .map((application) => {
        const listing = publicHost(application);
        const reviews = db.travelReviews.filter((review) => review.listingId === application.id);
        return {
          ...listing,
          rating: reviews.length ? Number((reviews.reduce((sum, review) => sum + review.rating, 0) / reviews.length).toFixed(1)) : null,
          reviewCount: reviews.length,
        };
      });
    res.json(listings);
  });

  app.get('/api/travel/favorites', auth, requireRole('traveller'), (req, res) => {
    const favoriteIds = new Set(Array.isArray(req.user.favoriteHosts) ? req.user.favoriteHosts : []);
    res.json(db.hostApplications.filter((application) => favoriteIds.has(application.id) && application.status === 'approved').map(publicHost));
  });

  app.put('/api/travel/favorites/:listingId', auth, requireRole('traveller'), (req, res) => {
    const listing = listingForId(req.params.listingId);
    if (!listing) return res.status(404).json({ error: 'Approved host listing not found.' });
    req.user.favoriteHosts ||= [];
    const exists = req.user.favoriteHosts.includes(listing.id);
    req.user.favoriteHosts = exists
      ? req.user.favoriteHosts.filter((id) => id !== listing.id)
      : [...new Set([...req.user.favoriteHosts, listing.id])];
    save();
    res.json({ saved: !exists, listingId: listing.id });
  });

  app.get('/api/travel/listings/:id/reviews', (req, res) => {
    if (!listingForId(req.params.id)) return res.status(404).json({ error: 'Listing not found.' });
    const reviews = db.travelReviews.filter((review) => review.listingId === req.params.id)
      .map(({ id, rating, comment, createdAt }) => ({ id, rating, comment, createdAt }));
    res.json(reviews);
  });

  app.post('/api/travel/host/applications', auth, limit(10, 60 * 60 * 1000), requireRole('traveller', 'host_applicant'), async (req, res) => {
    if (applicationForUser(req.user.id)) return res.status(409).json({ error: 'You already have a host application. Check your host dashboard for its status.' });
    const body = req.body || {};
    const legalName = cleanText(body.legalName, 100);
    const phone = cleanText(body.phone, 30);
    const publicName = cleanText(body.publicName, 60);
    const city = cleanText(body.city, 80);
    const area = cleanText(body.area, 100);
    const introduction = cleanText(body.introduction, 500);
    const gender = cleanText(body.gender, 30);
    const languages = Array.isArray(body.languages)
      ? [...new Set(body.languages.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean).map((item) => item.slice(0, 40)))].slice(0, 8)
      : [];
    const sourceServices = isObject(body.services) ? body.services : {};
    if (!legalName || !phone || !publicName || !city || !area || !introduction || !languages.length) {
      return res.status(400).json({ error: 'Complete your name, private contact phone, public name, city, area, introduction, and at least one language.' });
    }
    if (!body.policyAccepted) return res.status(400).json({ error: 'Accept the host safety, privacy, and conduct policies to submit.' });
    const availabilityFrom = parseDate(body.availabilityFrom, 'availability start date');
    const availabilityTo = parseDate(body.availabilityTo, 'availability end date');
    const today = new Date().toISOString().slice(0, 10);
    if (availabilityFrom < today || availabilityTo <= availabilityFrom) return res.status(400).json({ error: 'Choose a future availability range with an end after its start.' });
    const services = {};
    try {
      if (sourceServices.accommodation?.enabled) {
        services.accommodation = {
          enabled: true,
          pricePerNight: positivePrice(sourceServices.accommodation.pricePerNight, 'Nightly price'),
          propertyType: cleanText(sourceServices.accommodation.propertyType, 40),
          capacity: Number(sourceServices.accommodation.capacity),
          amenities: Array.isArray(sourceServices.accommodation.amenities) ? sourceServices.accommodation.amenities.filter((item) => typeof item === 'string').map((item) => item.trim().slice(0, 50)).filter(Boolean).slice(0, 12) : [],
          houseRules: cleanText(sourceServices.accommodation.houseRules, 500),
          hostLivesOnsite: Boolean(sourceServices.accommodation.hostLivesOnsite),
          propertyAddress: cleanText(sourceServices.accommodation.propertyAddress, 250),
        };
        if (!services.accommodation.propertyType || !Number.isInteger(services.accommodation.capacity) || services.accommodation.capacity < 1 || services.accommodation.capacity > 20 || !services.accommodation.propertyAddress) {
          throw new Error('Accommodation listings need a property type, capacity, and private property address.');
        }
      }
      if (sourceServices.food?.enabled) {
        services.food = {
          enabled: true,
          pricePerMeal: positivePrice(sourceServices.food.pricePerMeal, 'Meal price'),
          menu: cleanText(sourceServices.food.menu, 500),
          dietaryOptions: cleanText(sourceServices.food.dietaryOptions, 250),
          allergens: cleanText(sourceServices.food.allergens, 250),
        };
        if (!services.food.menu) throw new Error('Food listings need a menu description.');
      }
      if (sourceServices.exploration?.enabled) {
        services.exploration = {
          enabled: true,
          pricePerHour: positivePrice(sourceServices.exploration.pricePerHour, 'Exploration hourly price'),
          experiences: cleanText(sourceServices.exploration.experiences, 500),
          meetingArea: area,
          languages: languages.slice(),
        };
        if (!services.exploration.experiences) throw new Error('Exploration listings need an experience description.');
      }
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    if (!Object.keys(services).length) return res.status(400).json({ error: 'Select at least one service to offer.' });
    const application = {
      id: newId(),
      userId: req.user.id,
      legalName,
      privateEmail: req.user.email,
      phone,
      publicName,
      city,
      area,
      gender,
      languages,
      introduction,
      services,
      availabilityFrom,
      availabilityTo,
      status: 'submitted',
      verification: { identity: 'not_reviewed', property: 'not_reviewed', interview: 'not_scheduled', notes: '', reviewedAt: null },
      policyAcceptedAt: Date.now(),
      submittedAt: Date.now(),
      approvedAt: null,
    };
    try {
      await sendHostApplicationNotification({
        applicationId: application.id,
        publicName: application.publicName,
        city: application.city,
      });
    } catch (error) {
      const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 502;
      return res.status(status).json({ error: error.message || 'Meetaro could not notify the review team. Please try again.' });
    }
    db.hostApplications.push(application);
    req.user.role = 'host_applicant';
    recordAudit(req.user.id, 'host_application_submitted', application.id);
    save();
    res.status(201).json({ id: application.id, status: application.status, message: 'Application submitted for manual review. Your profile is not public until it is approved.' });
  });

  app.get('/api/travel/host/dashboard', auth, requireRole('host_applicant', 'host'), (req, res) => {
    const application = applicationForUser(req.user.id);
    if (!application) return res.status(404).json({ error: 'No host application was found.' });
    const bookings = db.travelBookings
      .filter((booking) => booking.hostId === req.user.id)
      .map((booking) => bookingView(booking, req.user, application));
    res.json({
      application: {
        id: application.id,
        publicName: application.publicName,
        city: application.city,
        area: application.area,
        status: application.status,
        availabilityFrom: application.availabilityFrom,
        availabilityTo: application.availabilityTo,
        services: publicServices(application.services),
        verification: application.verification,
        privateContact: { legalName: application.legalName, email: application.privateEmail, phone: application.phone },
      },
      bookings,
    });
  });

  app.get('/api/travel/bookings', auth, requireRole('traveller', 'host', 'host_applicant'), (req, res) => {
    const bookings = db.travelBookings.filter((booking) => booking.travellerId === req.user.id)
      .map((booking) => bookingView(booking, req.user, applicationForId(booking.listingId)));
    res.json(bookings);
  });

  app.post('/api/travel/bookings', auth, limit(30, 60 * 60 * 1000), requireRole('traveller'), (req, res) => {
    const body = req.body || {};
    const application = listingForId(body.listingId);
    if (!application) return res.status(404).json({ error: 'This host is not currently available for booking.' });
    let arrivalDate, departureDate;
    try {
      arrivalDate = parseDate(body.arrivalDate, 'arrival date');
      departureDate = parseDate(body.departureDate, 'departure date');
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    const nights = (Date.parse(`${departureDate}T00:00:00Z`) - Date.parse(`${arrivalDate}T00:00:00Z`)) / 86400000;
    if (arrivalDate < new Date().toISOString().slice(0, 10) || nights < 1 || nights > 30) return res.status(400).json({ error: 'Choose future dates for a stay of 1 to 30 nights.' });
    if (arrivalDate < application.availabilityFrom || departureDate > application.availabilityTo) return res.status(409).json({ error: 'The host has not confirmed availability for those dates.' });
    if (bookingConflict(application.id, arrivalDate, departureDate)) return res.status(409).json({ error: 'The host is already booked for some or all of those dates.' });
    const travellers = Number(body.travellers);
    if (!Number.isInteger(travellers) || travellers < 1 || travellers > 12) return res.status(400).json({ error: 'Choose between 1 and 12 travellers.' });
    const services = Array.isArray(body.services) ? [...new Set(body.services)] : [];
    if (!services.length || services.some((name) => !SERVICE_NAMES.has(name) || !application.services[name]?.enabled)) return res.status(400).json({ error: 'Select one or more services this host offers.' });
    if (services.includes('accommodation') && travellers > application.services.accommodation.capacity) return res.status(400).json({ error: 'The requested party is larger than this accommodation’s stated capacity.' });
    const genderPreference = ['woman', 'man', 'none'].includes(body.genderPreference) ? body.genderPreference : 'none';
    const genderMatches = genderPreference === 'none' || application.gender.toLocaleLowerCase() === genderPreference;
    if (!genderMatches && body.consentToPreferenceMismatch !== true) {
      return res.status(409).json({ error: 'This host does not match your selected host gender preference.', consentRequired: true });
    }
    const mealCount = services.includes('food') ? Number(body.mealCount) : 0;
    const explorationHours = services.includes('exploration') ? Number(body.explorationHours) : 0;
    if (!Number.isInteger(mealCount) || mealCount < 0 || mealCount > 90) return res.status(400).json({ error: 'Choose between 0 and 90 meals per traveller.' });
    if (!Number.isInteger(explorationHours) || explorationHours < 0 || explorationHours > 24) return res.status(400).json({ error: 'Choose between 0 and 24 exploration hours.' });
    if (services.includes('food') && mealCount < 1) return res.status(400).json({ error: 'Choose at least one meal per traveller.' });
    if (services.includes('exploration') && explorationHours < 1) return res.status(400).json({ error: 'Choose at least one hour of exploration.' });
    const foodPreferences = cleanText(body.foodPreferences, 300);
    const introduction = cleanText(body.introduction, 300);
    const accommodationSubtotal = services.includes('accommodation') ? application.services.accommodation.pricePerNight * nights : 0;
    const foodSubtotal = services.includes('food') ? application.services.food.pricePerMeal * mealCount * travellers : 0;
    const explorationSubtotal = services.includes('exploration') ? application.services.exploration.pricePerHour * explorationHours : 0;
    const total = accommodationSubtotal + foodSubtotal + explorationSubtotal;
    if (!Number.isSafeInteger(total) || total < 1) return res.status(400).json({ error: 'The request could not be priced.' });
    const booking = {
      id: newId(),
      listingId: application.id,
      hostId: application.userId,
      travellerId: req.user.id,
      travellerName: req.user.name.split(/\s+/)[0].slice(0, 40),
      arrivalDate,
      departureDate,
      nights,
      travellers,
      services,
      mealCount,
      explorationHours,
      genderPreference,
      consentedToMismatch: genderMatches ? false : true,
      foodPreferences,
      introduction,
      estimate: { accommodation: accommodationSubtotal, food: foodSubtotal, exploration: explorationSubtotal, taxes: 0, platformFee: 0, total },
      proposedTotal: total,
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    db.travelBookings.push(booking);
    recordAudit(req.user.id, 'booking_requested', booking.id);
    save();
    res.status(201).json(bookingView(booking, req.user, application));
  });

  app.post('/api/travel/bookings/:id/host-response', auth, requireRole('host', 'host_applicant'), (req, res) => {
    const found = bookingForUser(req.params.id, req.user);
    if (!found || found.booking.hostId !== req.user.id) return res.status(404).json({ error: 'Booking not found for this host.' });
    const { booking, application } = found;
    if (application.status !== 'approved') return res.status(403).json({ error: 'Only approved hosts can respond to booking requests.' });
    if (booking.status !== 'pending') return res.status(409).json({ error: 'This booking request has already been handled.' });
    if (req.body?.decision === 'decline') {
      booking.status = 'rejected';
    } else if (req.body?.decision === 'accept') {
      if (bookingConflict(booking.listingId, booking.arrivalDate, booking.departureDate, booking.id)) {
        return res.status(409).json({ error: 'Those dates have already been booked. The traveller has not been charged.' });
      }
      if (req.body.proposedTotal !== undefined) {
        const proposedTotal = Number(req.body.proposedTotal);
        if (!Number.isSafeInteger(proposedTotal) || proposedTotal < 1 || proposedTotal > 100000000) return res.status(400).json({ error: 'Enter a valid proposed total.' });
        booking.proposedTotal = proposedTotal;
      }
      booking.status = 'awaiting_traveller_confirmation';
    } else {
      return res.status(400).json({ error: 'Choose accept or decline.' });
    }
    booking.updatedAt = Date.now();
    recordAudit(req.user.id, `booking_${booking.status}`, booking.id);
    save();
    res.json(bookingView(booking, req.user, application));
  });

  app.post('/api/travel/bookings/:id/confirm', auth, requireRole('traveller'), (req, res) => {
    const found = bookingForUser(req.params.id, req.user);
    if (!found || found.booking.travellerId !== req.user.id) return res.status(404).json({ error: 'Booking not found for this traveller.' });
    const { booking, application } = found;
    if (booking.status !== 'awaiting_traveller_confirmation') return res.status(409).json({ error: 'This booking is not awaiting your confirmation.' });
    if (!application || application.status !== 'approved') return res.status(409).json({ error: 'The host is no longer available.' });
    if (booking.arrivalDate < application.availabilityFrom || booking.departureDate > application.availabilityTo ||
        bookingConflict(booking.listingId, booking.arrivalDate, booking.departureDate, booking.id)) {
      return res.status(409).json({ error: 'Availability changed before confirmation. The booking was not confirmed.' });
    }
    booking.status = 'confirmed';
    booking.updatedAt = Date.now();
    recordAudit(req.user.id, 'booking_confirmed', booking.id);
    save();
    res.json(bookingView(booking, req.user, application));
  });

  app.post('/api/travel/bookings/:id/cancel', auth, requireRole('traveller', 'host', 'host_applicant'), (req, res) => {
    const found = bookingForUser(req.params.id, req.user);
    if (!found) return res.status(404).json({ error: 'Booking not found.' });
    if (!['pending', 'awaiting_traveller_confirmation', 'confirmed'].includes(found.booking.status)) return res.status(409).json({ error: 'This booking can no longer be cancelled from the app.' });
    found.booking.status = 'cancelled';
    found.booking.updatedAt = Date.now();
    recordAudit(req.user.id, 'booking_cancelled', found.booking.id);
    save();
    res.json(bookingView(found.booking, req.user, found.application));
  });

  app.post('/api/travel/bookings/:id/complete', auth, requireRole('host'), (req, res) => {
    const found = bookingForUser(req.params.id, req.user);
    if (!found || found.booking.hostId !== req.user.id) return res.status(404).json({ error: 'Booking not found for this host.' });
    if (found.booking.status !== 'confirmed') return res.status(409).json({ error: 'Only confirmed bookings can be marked complete.' });
    found.booking.status = 'completed';
    found.booking.updatedAt = Date.now();
    recordAudit(req.user.id, 'booking_completed', found.booking.id);
    save();
    res.json(bookingView(found.booking, req.user, found.application));
  });

  app.post('/api/travel/bookings/:id/reviews', auth, requireRole('traveller'), (req, res) => {
    const booking = db.travelBookings.find((item) => item.id === req.params.id && item.travellerId === req.user.id);
    if (!booking || booking.status !== 'completed') return res.status(403).json({ error: 'A review is available only after a completed booking.' });
    if (db.travelReviews.some((review) => review.bookingId === booking.id)) return res.status(409).json({ error: 'You have already reviewed this booking.' });
    const rating = Number(req.body?.rating);
    const comment = cleanText(req.body?.comment, 1000);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5 || !comment) return res.status(400).json({ error: 'Add a rating from 1 to 5 and a written review.' });
    const review = { id: newId(), bookingId: booking.id, listingId: booking.listingId, travellerId: req.user.id, rating, comment, createdAt: Date.now() };
    db.travelReviews.push(review);
    recordAudit(req.user.id, 'booking_reviewed', booking.id);
    save();
    res.status(201).json({ id: review.id, rating: review.rating, comment: review.comment });
  });

  app.post('/api/travel/reports', auth, limit(10, 60 * 60 * 1000), (req, res) => {
    const booking = db.travelBookings.find((item) => item.id === req.body?.bookingId &&
      (item.travellerId === req.user.id || item.hostId === req.user.id));
    const reason = cleanText(req.body?.reason, 1000);
    if (!booking || !reason) return res.status(400).json({ error: 'Choose one of your bookings and describe the concern.' });
    const report = { id: newId(), bookingId: booking.id, reporterId: req.user.id, reason, status: 'open', createdAt: Date.now() };
    db.travelReports.push(report);
    recordAudit(req.user.id, 'travel_report_submitted', report.id);
    save();
    res.status(201).json({ id: report.id, status: report.status });
  });

  app.get('/api/admin/overview', ...requireAdmin, (req, res) => {
    const counts = (items, status) => items.filter((item) => item.status === status).length;
    res.json({
      travellers: db.users.filter((user) => (user.role || 'traveller') === 'traveller').length,
      hostApplications: db.hostApplications.length,
      pendingApplications: counts(db.hostApplications, 'submitted') + counts(db.hostApplications, 'under_review') + counts(db.hostApplications, 'verification_pending'),
      approvedHosts: counts(db.hostApplications, 'approved'),
      suspendedHosts: counts(db.hostApplications, 'suspended'),
      bookings: db.travelBookings.length,
      activeBookings: db.travelBookings.filter((item) => ['confirmed', 'in_progress'].includes(item.status)).length,
      openReports: counts(db.travelReports, 'open'),
    });
  });

  app.get('/api/admin/applications', ...requireAdmin, (req, res) => res.json(
    db.hostApplications.map((application) => ({
      ...application,
      userName: db.users.find((user) => user.id === application.userId)?.name || application.publicName,
    })),
  ));

  app.post('/api/admin/applications/:id/review', ...requireAdmin, (req, res) => {
    const application = applicationForId(req.params.id);
    if (!application) return res.status(404).json({ error: 'Host application not found.' });
    const body = req.body || {};
    if (!HOST_STATUSES.has(body.status)) return res.status(400).json({ error: 'Choose a valid review status.' });
    const notes = cleanText(body.notes, 1000);
    const verification = body.verification || {};
    if (body.status === 'approved' && (
      verification.identity !== 'passed' || verification.property !== 'passed' || verification.interview !== 'completed'
    )) {
      return res.status(400).json({ error: 'Approval requires the administrator to record completed identity, property, and interview checks.' });
    }
    if (['rejected', 'suspended'].includes(body.status) && !notes) return res.status(400).json({ error: 'Add a reason when rejecting or suspending a host.' });
    const nextVerification = {
      identity: ['not_reviewed', 'passed', 'failed'].includes(verification.identity) ? verification.identity : application.verification.identity,
      property: ['not_reviewed', 'passed', 'failed'].includes(verification.property) ? verification.property : application.verification.property,
      interview: ['not_scheduled', 'scheduled', 'completed', 'not_completed'].includes(verification.interview) ? verification.interview : application.verification.interview,
      notes,
      reviewedAt: Date.now(),
    };
    application.verification = nextVerification;
    application.status = body.status;
    application.approvedAt = body.status === 'approved' ? Date.now() : null;
    const host = db.users.find((user) => user.id === application.userId);
    if (host) host.role = body.status === 'approved' ? 'host' : body.status === 'suspended' ? 'host_suspended' : 'host_applicant';
    recordAudit(req.user.id, `host_application_${body.status}`, application.id);
    save();
    res.json({ id: application.id, status: application.status, verification: application.verification });
  });

  app.get('/api/admin/bookings', ...requireAdmin, (req, res) => res.json(
    db.travelBookings.map((booking) => bookingView(booking, req.user, applicationForId(booking.listingId))),
  ));

  app.get('/api/admin/reports', ...requireAdmin, (req, res) => res.json(db.travelReports));

  app.post('/api/admin/reports/:id/resolve', ...requireAdmin, (req, res) => {
    const report = db.travelReports.find((item) => item.id === req.params.id);
    const notes = cleanText(req.body?.notes, 1000);
    if (!report) return res.status(404).json({ error: 'Report not found.' });
    if (!notes) return res.status(400).json({ error: 'Add resolution notes.' });
    report.status = 'resolved';
    report.resolutionNotes = notes;
    report.resolvedAt = Date.now();
    report.resolvedBy = req.user.id;
    recordAudit(req.user.id, 'travel_report_resolved', report.id);
    save();
    res.json({ id: report.id, status: report.status });
  });

  app.get('/api/admin/audit', ...requireAdmin, (req, res) => res.json(db.travelAudit.slice(-500).reverse()));

}

module.exports = { registerTravelRoutes };
