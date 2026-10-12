const express = require("express");
const cors = require("cors");
const dialogflow = require("@google-cloud/dialogflow");
const path = require("path");
const db = require("./db");

const app = express();
app.use(cors());
app.use(express.json());

process.env.GOOGLE_APPLICATION_CREDENTIALS = path.join(
  __dirname,
  "service-account.json",
);
const projectId = "railway-bot-web-ruat";
const sessionClient = new dialogflow.SessionsClient();

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

function executeFulfillment(
  intentName,
  params,
  originalReply,
  rawMessage = "",
  allParamsPresent = false,
) {
  const lowerMsg = rawMessage.toLowerCase();

  // 1. Train Search Intent
  if (intentName && intentName.toLowerCase().includes("search")) {
    let fromCity =
      extractParam(params.source) ||
      extractParam(params["geo-city-from"]) ||
      extractParam(params.from_city) ||
      extractParam(params.departure_city);

    let toCity =
      extractParam(params.destination) ||
      extractParam(params["geo-city-to"]) ||
      extractParam(params.to_city) ||
      extractParam(params.arrival_city);

    const knownCities = [
      "mumbai",
      "delhi",
      "ahmedabad",
      "chennai",
      "kolkata",
      "pune",
      "bangalore",
    ];

    if (!fromCity) {
      const fromMatch = lowerMsg.match(/from\s+([a-zA-Z]+)/);
      if (fromMatch && knownCities.includes(fromMatch[1])) {
        fromCity = fromMatch[1];
      }
    }

    if (!toCity) {
      const toMatch = lowerMsg.match(/to\s+([a-zA-Z]+)/);
      if (toMatch && knownCities.includes(toMatch[1])) {
        toCity = toMatch[1];
      }
    }

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
            : `origin ${fromCity.toUpperCase()}`;
      return `❌ No direct trains found for ${routeText}. Please check the stations or try another route.`;
    }

    const routeHeader =
      fromCity && toCity
        ? `(${fromCity.toUpperCase()} ➔ ${toCity.toUpperCase()})`
        : toCity
          ? `(Arriving at ${toCity.toUpperCase()})`
          : `(Departing from ${fromCity.toUpperCase()})`;

    let response = `🚆 Trains available ${routeHeader}:\n\n`;
    matches.forEach((t, idx) => {
      const seatInfo = Object.entries(t.seats)
        .map(([cls, count]) => `${cls}: ${count} seats (₹${t.fare[cls]})`)
        .join(" | ");
      response += `${idx + 1}. ${t.number} - ${t.name}\n   Dep: ${t.departure} | Arr: ${t.arrival}\n   Availability: ${seatInfo}\n\n`;
    });
    response += `To book, say: "Book ticket in train [Train Number]"`;
    return response;
  }

  // 2. Ticket Booking Intent
  if (
    intentName &&
    (intentName.toLowerCase().includes("book") ||
      intentName.toLowerCase().includes("reservation"))
  ) {
    if (!allParamsPresent) {
      return originalReply;
    }

    let trainNum =
      extractParam(params.train_number) ||
      extractParam(params.number) ||
      extractParam(params["train-number"]);

    let travelClass = (
      extractParam(params.travel_class) ||
      extractParam(params.class) ||
      extractParam(params["travel-class"]) ||
      "3A"
    ).toUpperCase();

    let passengerName =
      extractParam(params.passenger_name) ||
      extractParam(params["given-name"]) ||
      extractParam(params.person) ||
      extractParam(params.name);

    if (!trainNum) {
      const numMatch = rawMessage.match(/\b\d{5}\b/);
      if (numMatch) trainNum = numMatch[0];
    }
    if (!passengerName && !rawMessage.match(/^\d+$/)) {
      passengerName = rawMessage
        .replace(/book|ticket|for|in|class|1a|2a|3a|sl/gi, "")
        .trim();
    }
    if (!passengerName) passengerName = "Passenger";

    const train =
      (trainNum ? db.getTrainByNumber(trainNum) : null) || db.getTrains()[0];
    const actualTrainNum = train ? train.number : trainNum || "12951";
    const actualTrainName = train ? train.name : "Express Special";

    const generatedPnr = String(
      Math.floor(1000000000 + Math.random() * 9000000000),
    );
    const randomCoach =
      travelClass === "1A" ? "H1" : travelClass === "2A" ? "A1" : "B3";
    const randomBerth = `${Math.floor(Math.random() * 60) + 1} (${["Lower", "Upper", "Side Lower", "Middle"][Math.floor(Math.random() * 4)]})`;
    const fare =
      train && train.fare && train.fare[travelClass]
        ? train.fare[travelClass]
        : 2200;

    const newBooking = {
      pnr: generatedPnr,
      passenger: passengerName,
      trainNumber: actualTrainNum,
      trainName: actualTrainName,
      travelClass: travelClass,
      coach: randomCoach,
      berth: randomBerth,
      farePaid: fare,
      status: "CNF (Confirmed)",
      bookingDate: new Date().toLocaleDateString("en-IN"),
    };

    db.createBooking(newBooking);
    console.log("[DB] Successfully created and saved booking:", newBooking);

    return (
      `🎟️ Booking Confirmed!\n\n` +
      `• PNR Number: ${generatedPnr}\n` +
      `• Passenger: ${passengerName}\n` +
      `• Train: ${actualTrainNum} - ${actualTrainName}\n` +
      `• Class: ${travelClass} | Coach: ${randomCoach} | Berth: ${randomBerth}\n` +
      `• Total Fare: ₹${fare} (Paid)\n` +
      `• Status: Confirmed\n\n` +
      `You can track or cancel this reservation anytime using PNR: ${generatedPnr}`
    );
  }

  // 3. PNR Status Check Intent
  if (intentName && intentName.toLowerCase().includes("pnr")) {
    const rawPnr =
      extractParam(params.pnr_number) ||
      extractParam(params.number_sequence) ||
      (rawMessage.match(/\d{10}/) ? rawMessage.match(/\d{10}/)[0] : null);
    if (!rawPnr) return originalReply;

    const record = db.getBooking(rawPnr);
    if (!record) {
      return `❌ PNR ${rawPnr} not found in the reservation system.`;
    }

    return (
      `📋 Live PNR Status: ${record.pnr}\n\n` +
      `• Passenger: ${record.passenger}\n` +
      `• Train: ${record.trainNumber} - ${record.trainName}\n` +
      `• Class: ${record.travelClass}\n` +
      `• Berth: Coach ${record.coach}, Berth ${record.berth}\n` +
      `• Current Status: ${record.status}\n` +
      `• Charting Status: Chart Prepared`
    );
  }

  // 4. Ticket Cancellation Intent
  if (intentName && intentName.toLowerCase().includes("cancel")) {
    const rawPnr =
      extractParam(params.pnr_number) ||
      extractParam(params.number_sequence) ||
      (rawMessage.match(/\d{10}/) ? rawMessage.match(/\d{10}/)[0] : null);
    if (!rawPnr) return originalReply;

    const record = db.getBooking(rawPnr);
    if (!record) {
      return `❌ Cancellation failed: PNR ${rawPnr} does not exist in the active records.`;
    }

    if (record.status.includes("Cancelled")) {
      return `ℹ️ Ticket for PNR ${rawPnr} has already been cancelled.`;
    }

    const deduction = 240;
    const refundAmount = Math.max(0, record.farePaid - deduction);
    db.updateBookingStatus(rawPnr, "CAN (Cancelled)");

    return (
      `✅ Ticket Cancelled Successfully!\n\n` +
      `• PNR: ${record.pnr}\n` +
      `• Passenger: ${record.passenger}\n` +
      `• Train: ${record.trainNumber} - ${record.trainName}\n` +
      `• Cancellation Fee Deducted: ₹${deduction}\n` +
      `• Refund Initiated: ₹${refundAmount}\n` +
      `• Reference: CAN-${Math.floor(100000 + Math.random() * 900000)}`
    );
  }

  return originalReply;
}

app.post("/api/chat", async (req, res) => {
  try {
    const { message, sessionId = "default-web-session" } = req.body;
    if (!message)
      return res.status(400).json({ error: "Message text is required." });

    const sessionPath = sessionClient.projectAgentSessionPath(
      projectId,
      sessionId,
    );
    const request = {
      session: sessionPath,
      queryInput: {
        text: {
          text: message,
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
    const fallbackText =
      result.fulfillmentText ||
      "I did not understand that. Could you please rephrase?";

    const finalReply = executeFulfillment(
      matchedIntent,
      params,
      fallbackText,
      message,
      result.allRequiredParamsPresent,
    );

    res.json({
      reply: finalReply,
      intent: matchedIntent,
      allRequiredParamsPresent: result.allRequiredParamsPresent,
    });
  } catch (error) {
    console.error("Dialogflow API Error:", error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`RailAssist Bridge Server running on http://localhost:${PORT}`);
});
