const fs = require("fs");
const path = require("path");

const DB_FILE = path.join(__dirname, "db.json");

// Read DB from file
function loadDB() {
  try {
    const rawData = fs.readFileSync(DB_FILE, "utf8");
    return JSON.parse(rawData);
  } catch (error) {
    console.error("Error reading db.json:", error);
    return { trains: [], bookings: {} };
  }
}

// Write DB changes back to file
function saveDB(data) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), "utf8");
  } catch (error) {
    console.error("Error writing to db.json:", error);
  }
}

// Database helper functions
const db = {
  getTrains() {
    return loadDB().trains;
  },

  getTrainByNumber(number) {
    const trains = loadDB().trains;
    return trains.find((t) => t.number === String(number));
  },

  getBooking(pnr) {
    const bookings = loadDB().bookings;
    return bookings[String(pnr)] || null;
  },

  createBooking(bookingData) {
    const data = loadDB();
    data.bookings[bookingData.pnr] = bookingData;
    saveDB(data);
    return bookingData;
  },

  updateBookingStatus(pnr, status) {
    const data = loadDB();
    if (data.bookings[pnr]) {
      data.bookings[pnr].status = status;
      saveDB(data);
      return data.bookings[pnr];
    }
    return null;
  },
};

module.exports = db;
