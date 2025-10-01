import express, { Request, Response } from 'express'; 

const app = express();

const port = process.env.PORT || 3000; 

/**
 * Starts a minimal Express web server to keep the service awake.
 */
export default function keepAlive() {
  // Use the imported Request and Response types to satisfy TypeScript
  app.get('/', (req: Request, res: Response) => { 
    res.send('Mirror Bot is Awake!'); 
  });

  // Start the Express server, listening on the designated port
  app.listen(port, () => {
    console.log(`Keep Alive Web Server running on port ${port}`);
  });
}
