// CRITICAL FIX: This line loads the environment variables from the .env file
// into process.env before the rest of the application initializes.
import 'dotenv/config'; 

import { listen } from "./modules/Discord.js";

import keepAlive from './keepAlive.js';

// 1. Call it first to start the web server, which keeps the process alive
keepAlive();

// 2. Start the main bot logic
listen();
