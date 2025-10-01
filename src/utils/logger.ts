/* eslint-disable typescript/naming-convention */
// CRITICAL FIX: We are replacing the ES6 'import' with the CommonJS 'require' 
// and casting the module to 'any'. This is the most reliable way to bypass the 
// TS2307 error when the third-party module lacks proper type definitions, 
// ensuring the compiler finds the module without issue.
const Logger: any = require("@ptkdev/logger"); 

import { debugMode } from "./env.js";

// Define the options object.
const options = {
    language: "en",
    colors: true,
    debug: debugMode ?? false,
    info: true,
    warning: true,
    error: true,
    sponsor: true,
    write: true,
    type: "log",
    rotate: {
        size: "10M",
        encoding: "utf8"
    },
    path: {
        debug_log: "./logs/debug.log",
        error_log: "./logs/error.log"
    }
};

// The 'as any' on the options argument remains to suppress errors related to the 
// specific structure of the LoggerOptions object.
const logger = new Logger(options as any);

export default logger;
