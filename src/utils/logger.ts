/* eslint-disable typescript/naming-convention */
// Note: We remove the import of 'LoggerOptions' as it was causing TS2307 error.
import Logger from "@ptkdev/logger";
import { debugMode } from "./env.js";

// Define the options object. The type assertion 'as any' will be used during instantiation
// to prevent compilation failure if the Logger library's types are not found.
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

// CRITICAL FIX: Use 'as any' on the options argument to bypass the TS2307 error 
// caused by the compiler not finding type declarations for the external library.
const logger = new Logger(options as any);

export default logger;
