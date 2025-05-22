// backend/netlify/functions/route.js
const { parse } = require('url');

exports.handler = async (event, context) => {
  const { path } = parse(event.rawUrl);
  const activeBranch = process.env.ACTIVE_BRANCH || 'blue'; // Default to blue

  // New unified message endpoint
  if (path === '/routing-info') {
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'X-Environment': activeBranch
      },
      body: JSON.stringify({ 
        message: 'Routing handled by Netlify redirects',
        activeBranch
      })
    };
  }

  // Handle API routes
  if (path.startsWith('/api/')) {
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'X-Environment': activeBranch
      },
      body: JSON.stringify({ message: 'API request routed' })
    };
  }

  // Handle static asset routing
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'text/html',
      'X-Environment': activeBranch,
      'Cache-Control': 'no-cache'
    },
    body: `
      <!DOCTYPE html>
      <html>
        <head>
          <meta http-equiv="refresh" content="0; url=/${activeBranch}${path}" />
        </head>
        <body>
          <p>Redirecting to ${activeBranch} environment...</p>
        </body>
      </html>
    `
  };
};
