const express = require("express");
const cors = require("cors");
const dialogflow = require("@google-cloud/dialogflow");
const path = require("path");
const db = require("./db");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname)); // Serves index.html directly on localhost:3000

process.env.GOOGLE_APPLICATION_CREDENTIALS = path.join(
  __dirname,
  "service-account.json",
);
const projectId = "railway-bot-web-ruat";
const sessionClient = new dialogflow.SessionsClient();
const contextsClient = new dialogflow.ContextsClient();

// Multi-turn booking session tracker
const bookingSessions = {};

// City & Station Aliases
const CITY_ALIASES = {
  mumbai: [
    "mumbai",
    "mum",
    "bombay",
    "cst",
    "csmt",
    "bct",
    "central",
    "dadar",
    "kurla",
    "thane",
  ],
  delhi: ["delhi", "dli", "ndls", "nizamuddin", "hnzm", "new delhi"],
  ahmedabad: ["ahmedabad", "adi", "amdavad", "sabarmati"],
  chennai: ["chennai", "mas", "madras"],
  kolkata: ["kolkata", "hwh", "howrah", "sealdah"],
  pune: ["pune", "pnq"],
  bangalore: ["bangalore", "bengaluru", "sbc"],
};

// Banned words & slang filter for passenger names
const BANNED_WORDS = [
  "idiot",
  "stupid",
  "jhatu",
  "chutiya",
  "harami",
  "kamina",
  "panga",
  "lala",
  "gandu",
  "bondo",
  "fake",
  "test",
  "null",
  "undefined",
  "anonymous",
];

function normalizeCity(input) {
  if (!input) return null;
  const clean = input.toLowerCase().trim();
  for (const [standardCity, aliases] of Object.entries(CITY_ALIASES)) {
    if (aliases.some((alias) => clean.includes(alias))) {
      return standardCity;
    }
  }
  return clean;
}

function isValidName(name) {
  if (!name || name.trim().length < 3) return false;
  const clean = name.trim().toLowerCase();

  // Must only contain letters and single spaces
  if (!/^[a-zA-Z]+(\s[a-zA-Z]+)*$/.test(name.trim())) return false;

  // Reject banned terms
  for (const word of BANNED_WORDS) {
    if (clean.includes(word)) return false;
  }
  return true;
}

function extractParam(paramField) {
  if (!paramField) return null;
  if (paramField.stringValue !== undefined && paramField.stringValue !== "") {
    return paramField.stringValue.trim();
  }
  if (paramField.numberValue !== undefined && paramField.numberValue !== null) {
    return String(Math.round(paramField.numberValue));
  }
  if (paramField.structValue && paramField.structValue.fields) {
    const fields = paramField.structValue.fields;
    const nameKey = Object.keys(fields).find((k) => fields[k].stringValue);
    if (nameKey) return fields[nameKey].stringValue.trim();
  }
  if (
    paramField.listValue &&
    paramField.listValue.values &&
    paramField.listValue.values.length > 0
  ) {
    return extractParam(paramField.listValue.values[0]);
  }
  return null;
}

// -------------------------------------------------------------
// Controlled Multi-Turn Booking Handler (Strict Step Machine)
// -------------------------------------------------------------
function handleBookingStep(sessionId, message) {
  const session = bookingSessions[sessionId];
  const cleanMsg = message.trim();

  // STEP 1: Validate Train Number
  if (session.step === "train") {
    const numMatch = cleanMsg.match(/\b\d{5}\b/);
    if (!numMatch) {
      return `⚠️ "${cleanMsg}" is not a valid 5-digit train number.\n\nPlease provide a 5-digit number (e.g., 12951, 12953, 12009, 22221), or type "exit" to cancel.`;
    }

    const trainFound = db.getTrainByNumber(numMatch[0]);
    if (!trainFound) {
      return `⚠️ Train number ${numMatch[0]} was not found in our operational schedule.\n\nPlease enter an active train number (e.g., 12951, 12953, 12009, 22221) or type "exit".`;
    }

    session.data.trainNumber = trainFound.number;
    session.data.trainName = trainFound.name;
    session.data.trainObj = trainFound;
    session.step = "class"; // Advance to Step 2

    const availableClasses = Object.keys(trainFound.seats).join(", ");
    return `✅ Train selected: ${trainFound.number} - ${trainFound.name}\n\nWhich travel class would you prefer? (${availableClasses})`;
  }

  // STEP 2: Validate Travel Class
  if (session.step === "class") {
    const upperInput = cleanMsg.toUpperCase();
    const train =
      session.data.trainObj || db.getTrainByNumber(session.data.trainNumber);
    const validClasses = Object.keys(train.seats);

    const matchedClass = validClasses.find((cls) => upperInput.includes(cls));

    if (!matchedClass) {
      return `⚠️ "${cleanMsg}" is not an available class for this train.\n\nPlease choose from: ${validClasses.join(", ")} (or type "exit" to cancel).`;
    }

    session.data.travelClass = matchedClass;
    session.step = "name"; // Advance to Step 3
    return `✅ Class ${matchedClass} selected (Fare: ₹${train.fare[matchedClass]}).\n\nPlease enter the Passenger's Full Name (e.g., Rajesh Sharma).`;
  }

  // STEP 3: Validate Passenger Name
  if (session.step === "name") {
    if (!isValidName(cleanMsg)) {
      return `⚠️ "${cleanMsg}" is not a valid passenger name.\n\nPlease enter a real full name using letters only (e.g., "Rajesh Sharma"), or type "exit" to cancel.`;
    }

    session.data.passengerName = cleanMsg.trim();

    const train = session.data.trainObj;
    const travelClass = session.data.travelClass;
    const generatedPnr = String(
      Math.floor(1000000000 + Math.random() * 9000000000),
    );
    const coachPrefix =
      travelClass === "1A"
        ? "H1"
        : travelClass === "2A"
          ? "A1"
          : travelClass === "CC"
            ? "C1"
            : "B2";
    const randomBerth = `${Math.floor(Math.random() * 50) + 1} (${
      ["Lower", "Upper", "Side Lower", "Window"][Math.floor(Math.random() * 4)]
    })`;
    const fare = (train.fare && train.fare[travelClass]) || 2200;

    const newBooking = {
      pnr: generatedPnr,
      passenger: session.data.passengerName,
      trainNumber: train.number,
      trainName: train.name,
      travelClass: travelClass,
      coach: coachPrefix,
      berth: randomBerth,
      farePaid: fare,
      status: "CNF (Confirmed)",
      bookingDate: new Date().toLocaleDateString("en-IN"),
    };

    db.createBooking(newBooking);
    console.log("[DB] Confirmed booking:", newBooking);

    // Clear session state upon completion
    delete bookingSessions[sessionId];

    return (
      `🎟️ Booking Confirmed!\n\n` +
      `• PNR Number: ${generatedPnr}\n` +
      `• Passenger: ${newBooking.passenger}\n` +
      `• Train: ${newBooking.trainNumber} - ${newBooking.trainName}\n` +
      `• Class: ${travelClass} | Coach: ${coachPrefix} | Berth: ${randomBerth}\n` +
      `• Total Fare: ₹${fare} (Paid)\n` +
      `• Current Status: Confirmed\n\n` +
      `You can check status or cancel anytime using PNR: ${generatedPnr}`
    );
  }

  delete bookingSessions[sessionId];
  return "Session reset. Type 'book ticket' to begin again.";
}

// -------------------------------------------------------------
// Intent & Query Router
// -------------------------------------------------------------
function executeFulfillment(
  intentName,
  params,
  originalReply,
  rawMessage = "",
  sessionId,
) {
  const cleanMsg = rawMessage.trim();
  const lowerMsg = cleanMsg.toLowerCase();

  // 1. Train Search Intent
  if (intentName && intentName.toLowerCase().includes("search")) {
    let rawFrom =
      extractParam(params.source) ||
      extractParam(params["geo-city-from"]) ||
      extractParam(params.from_city);
    let rawTo =
      extractParam(params.destination) ||
      extractParam(params["geo-city-to"]) ||
      extractParam(params.to_city);

    if (!rawFrom) {
      const fromMatch = lowerMsg.match(
        /from\s+([a-zA-Z\s]+?)(?=\s+to|\s+tomorrow|\s+today|$)/,
      );
      if (fromMatch) rawFrom = fromMatch[1];
    }
    if (!rawTo) {
      const toMatch = lowerMsg.match(
        /to\s+([a-zA-Z\s]+?)(?=\s+from|\s+tomorrow|\s+today|$)/,
      );
      if (toMatch) rawTo = toMatch[1];
    }

    const fromCity = normalizeCity(rawFrom);
    const toCity = normalizeCity(rawTo);

    let matches = db.getTrains();

    if (fromCity && toCity) {
      matches = matches.filter(
        (t) =>
          t.from.toLowerCase() === fromCity && t.to.toLowerCase() === toCity,
      );
    } else if (fromCity) {
      matches = matches.filter((t) => t.from.toLowerCase() === fromCity);
    } else if (toCity) {
      matches = matches.filter((t) => t.to.toLowerCase() === toCity);
    }

    if (matches.length === 0) {
      const routeText =
        fromCity && toCity
          ? `${fromCity.toUpperCase()} to ${toCity.toUpperCase()}`
          : toCity
            ? `destination ${toCity.toUpperCase()}`
            : `origin ${fromCity ? fromCity.toUpperCase() : "specified location"}`;
      return `❌ No direct trains found for ${routeText}.\n\n💡 Try available routes:\n• Mumbai ➔ Delhi\n• Mumbai ➔ Ahmedabad`;
    }

    const header =
      fromCity && toCity
        ? `(${fromCity.toUpperCase()} ➔ ${toCity.toUpperCase()})`
        : toCity
          ? `(Arriving at ${toCity.toUpperCase()})`
          : `(Departing from ${fromCity.toUpperCase()})`;

    let response = `🚆 Trains available ${header}:\n\n`;
    matches.forEach((t, idx) => {
      const seatInfo = Object.entries(t.seats)
        .map(([cls, count]) => `${cls}: ${count} seats (₹${t.fare[cls]})`)
        .join(" | ");
      response += `${idx + 1}. ${t.number} - ${t.name}\n   Dep: ${t.departure} | Arr: ${
        t.arrival
      }\n   Availability: ${seatInfo}\n\n`;
    });
    response += `To book, reply: "Book ticket in train [Train Number]"`;
    return response;
  }

  // 2. Ticket Booking Intent Initialization
  const hasBookingKeyword =
    /\b(book|booking|ticket|reserve|reservation)\b/i.test(cleanMsg);
  if (
    intentName &&
    (intentName.toLowerCase().includes("book") ||
      intentName.toLowerCase().includes("reservation")) &&
    hasBookingKeyword
  ) {
    // Check for one-shot booking (e.g. "Book 3A ticket on 12951 for Priya")
    const numMatch = cleanMsg.match(/\b\d{5}\b/);
    const validClasses = ["1A", "2A", "3A", "SL", "CC", "EC"];
    const matchedClass = validClasses.find((cls) =>
      cleanMsg.toUpperCase().includes(cls),
    );

    if (numMatch && matchedClass) {
      const train = db.getTrainByNumber(numMatch[0]);
      if (train) {
        const passenger =
          cleanMsg
            .replace(
              /book|ticket|for|in|class|1a|2a|3a|sl|cc|ec|\b\d{5}\b/gi,
              "",
            )
            .trim() || "Passenger";

        const generatedPnr = String(
          Math.floor(1000000000 + Math.random() * 9000000000),
        );
        const coachPrefix =
          matchedClass === "1A" ? "H1" : matchedClass === "2A" ? "A1" : "B2";
        const fare = train.fare[matchedClass] || 2200;

        const newBooking = {
          pnr: generatedPnr,
          passenger: passenger,
          trainNumber: train.number,
          trainName: train.name,
          travelClass: matchedClass,
          coach: coachPrefix,
          berth: "24 (Lower)",
          farePaid: fare,
          status: "CNF (Confirmed)",
          bookingDate: new Date().toLocaleDateString("en-IN"),
        };
        db.createBooking(newBooking);

        return (
          `🎟️ Booking Confirmed!\n\n` +
          `• PNR Number: ${generatedPnr}\n` +
          `• Passenger: ${passenger}\n` +
          `• Train: ${train.number} - ${train.name}\n` +
          `• Class: ${matchedClass} | Coach: ${coachPrefix} | Berth: 24 (Lower)\n` +
          `• Total Fare: ₹${fare} (Paid)\n` +
          `• Current Status: Confirmed\n\n` +
          `You can track or cancel anytime using PNR: ${generatedPnr}`
        );
      }
    }

    // Start sequential guided multi-turn flow: step 1 (train)
    bookingSessions[sessionId] = { step: "train", data: {} };
    return "Which train number would you like to book? (e.g., 12951, 12953, 12009)";
  }

  // 3. PNR Status Check Intent
  if (intentName && intentName.toLowerCase().includes("pnr")) {
    const pnrMatch = cleanMsg.match(/\b\d{10}\b/);
    const rawPnr = pnrMatch ? pnrMatch[0] : extractParam(params.pnr_number);

    if (!rawPnr) {
      return `⚠️ Please provide a valid 10-digit PNR number.\nExample: "Check PNR 8492019482"`;
    }

    const record = db.getBooking(rawPnr);
    if (!record) {
      return `❌ PNR ${rawPnr} not found in reservation records. Please verify the 10-digit number.`;
    }

    return (
      `📋 Live PNR Status: ${record.pnr}\n\n` +
      `• Passenger: ${record.passenger}\n` +
      `• Train: ${record.trainNumber} - ${record.trainName}\n` +
      `• Class: ${record.travelClass}\n` +
      `• Coach: ${record.coach} | Berth: ${record.berth}\n` +
      `• Status: ${record.status}\n` +
      `• Chart Status: Chart Prepared`
    );
  }

  // 4. Ticket Cancellation Intent
  if (intentName && intentName.toLowerCase().includes("cancel")) {
    const pnrMatch = cleanMsg.match(/\b\d{10}\b/);
    const rawPnr = pnrMatch ? pnrMatch[0] : extractParam(params.pnr_number);

    if (!rawPnr) {
      return `⚠️ Please provide your 10-digit PNR to cancel your ticket.\nExample: "Cancel PNR 8492019482"`;
    }

    const record = db.getBooking(rawPnr);
    if (!record) {
      return `❌ Cancellation failed: PNR ${rawPnr} does not exist in our active database.`;
    }

    if (record.status.includes("Cancelled") || record.status.includes("CAN")) {
      return `ℹ️ Ticket for PNR ${rawPnr} is already CANCELLED. No further action needed.`;
    }

    const deduction = 240;
    const refundAmount = Math.max(0, record.farePaid - deduction);
    db.updateBookingStatus(rawPnr, "CAN (Cancelled)");

    return (
      `✅ Ticket Cancelled Successfully!\n\n` +
      `• PNR: ${record.pnr}\n` +
      `• Passenger: ${record.passenger}\n` +
      `• Train: ${record.trainNumber} - ${record.trainName}\n` +
      `• Cancellation Fee: ₹${deduction}\n` +
      `• Refund Amount: ₹${refundAmount} (initiated to source account)\n` +
      `• Cancellation ID: CAN-${Math.floor(100000 + Math.random() * 900000)}`
    );
  }

  // 5. Intelligent Static Railway FAQs
  const FAQS = [
    {
      keywords: ["food", "meal", "catering", "pantry"],
      reply:
        "🍱 Catering Info: Rajdhani & Shatabdi trains provide complimentary onboard meals (veg/non-veg). For other express services, e-catering via IRCTC is available at major stops.",
    },
    {
      keywords: ["luggage", "baggage", "weight", "limit"],
      reply:
        "🧳 Luggage Policy: Free allowance is 70 kg for AC 1st Class, 50 kg for 2-Tier AC, and 40 kg for 3-Tier AC. Excess luggage can be booked in the parcel van.",
    },
    {
      keywords: ["pet", "dog", "cat", "animal"],
      reply:
        "🐕 Pet Travel: Pets are permitted only in AC First Class (1A) cabins (subject to full cabin booking) or in the Guard Brake Van kennel box with a veterinary certificate.",
    },
    {
      keywords: ["tatkal", "quota", "timing"],
      reply:
        "⏰ Tatkal Timings: Tatkal AC booking opens at 10:00 AM daily, and Sleeper opens at 11:00 AM, one day prior to departure date.",
    },
  ];

  for (const faq of FAQS) {
    if (faq.keywords.some((k) => lowerMsg.includes(k))) {
      return faq.reply;
    }
  }

  // 6. Default Fallback
  return (
    `🤔 I didn't recognize that request. As your Railway Assistant, I can help you with:\n\n` +
    `• 🔍 Search Trains: "Trains from Mumbai to Delhi"\n` +
    `• 🎟️ Book Ticket: "Book a ticket"\n` +
    `• 📋 Check PNR: "Check PNR 8492019482"\n` +
    `• ❌ Cancel Ticket: "Cancel PNR 8492019482"\n\n` +
    `Type "exit" anytime to reset.`
  );
}

// -------------------------------------------------------------
// POST /api/chat Endpoint
// -------------------------------------------------------------
app.post("/api/chat", async (req, res) => {
  try {
    const { message, sessionId = "default-web-session" } = req.body;
    if (!message || message.trim() === "") {
      return res.status(400).json({ error: "Empty message text." });
    }

    const cleanMsg = message.trim();
    const sessionPath = sessionClient.projectAgentSessionPath(
      projectId,
      sessionId,
    );

    // 1. Emergency Exit / Reset Handler
    const exitWords = [
      "exit",
      "quit",
      "stop",
      "reset",
      "abort",
      "cancel booking",
    ];
    if (exitWords.includes(cleanMsg.toLowerCase())) {
      delete bookingSessions[sessionId];
      try {
        await contextsClient.deleteAllContexts({ parent: sessionPath });
      } catch (e) {}
      return res.json({
        reply:
          "🔄 Current operation stopped. How else may I assist your journey?",
        intent: "ResetFlow",
      });
    }

    // 2. Intercept: If user is inside booking flow
    if (bookingSessions[sessionId]) {
      const hasTenDigitPnr = /\b\d{10}\b/.test(cleanMsg);
      const isPnrQuery = /pnr|status/i.test(cleanMsg) && hasTenDigitPnr;
      const isCancelQuery = /cancel/i.test(cleanMsg) && hasTenDigitPnr;

      if (isPnrQuery || isCancelQuery) {
        // Clear booking state so the urgent inquiry is served
        delete bookingSessions[sessionId];
      } else {
        // Route to controlled multi-turn step handler
        const stepReply = handleBookingStep(sessionId, cleanMsg);
        return res.json({ reply: stepReply, intent: "book_ticket_step" });
      }
    }

    // 3. Dialogflow NLU Detection
    const request = {
      session: sessionPath,
      queryInput: {
        text: {
          text: cleanMsg,
          languageCode: "en",
        },
      },
    };

    const responses = await sessionClient.detectIntent(request);
    const result = responses[0].queryResult;

    const matchedIntent = result.intent ? result.intent.displayName : "None";
    const params =
      result.parameters && result.parameters.fields
        ? result.parameters.fields
        : {};
    const fallbackText = result.fulfillmentText || "";

    let finalReply = executeFulfillment(
      matchedIntent,
      params,
      fallbackText,
      cleanMsg,
      sessionId,
    );

    // Guard against empty strings or missing dialogflow messages
    if (
      !finalReply ||
      finalReply.trim() === "" ||
      finalReply.includes("No response text received")
    ) {
      finalReply =
        `🤔 I didn't quite catch that. As your Railway Assistant, I can help you with:\n\n` +
        `• 🔍 Search: "Trains from Mumbai to Delhi"\n` +
        `• 🎟️ Booking: "Book a train ticket"\n` +
        `• 📋 PNR Status: "Check PNR 8492019482"\n` +
        `• ❌ Cancel: "Cancel PNR 8492019482"\n\n` +
        `What would you like to do?`;
    }

    res.json({
      reply: finalReply,
      intent: matchedIntent,
    });
  } catch (error) {
    console.error("API Error:", error);
    res
      .status(500)
      .json({ error: "Server processing error: " + error.message });
  }
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`RailAssist Bridge Server running on http://localhost:${PORT}`);
});
