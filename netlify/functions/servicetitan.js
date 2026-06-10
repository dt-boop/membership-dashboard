// netlify/functions/servicetitan.js
// ServiceTitan Membership Dashboard - Data Proxy Function

const ST_AUTH_URL = 'https://auth.servicetitan.io/connect/token';
const ST_API_BASE = 'https://api.servicetitan.io';

// In-memory token cache (resets on cold start, which is fine)
let cachedToken = null;
let tokenExpiry = null;

async function getAccessToken() {
  if (cachedToken && tokenExpiry && Date.now() < tokenExpiry) {
    return cachedToken;
  }

  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: process.env.ST_APP_ID,
    client_secret: process.env.ST_CLIENT_SECRET,
  });

  const response = await fetch(ST_AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`ServiceTitan auth failed (${response.status}): ${text}`);
  }

  const data = await response.json();
  cachedToken = data.access_token;
  // Expire 60s early to avoid edge cases
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

async function fetchAllMemberships(token, queryParams) {
  const tenantId = process.env.ST_TENANT_ID;
  const appKey = process.env.ST_APP_KEY;
  let allItems = [];
  let page = 1;
  let hasMore = true;

  while (hasMore && page <= 20) {
    const url = new URL(`${ST_API_BASE}/memberships/v2/tenant/${tenantId}/memberships`);
    url.searchParams.set('pageSize', '500');
    url.searchParams.set('page', page.toString());
    Object.entries(queryParams).forEach(([k, v]) => {
      if (v != null) url.searchParams.set(k, v);
    });

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${token}`,
        'ST-App-Key': appKey,
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`ServiceTitan API error (${response.status}): ${text}`);
    }

    const data = await response.json();
    const items = data.data || [];
    // Log first item keys on first page to diagnose field names
    if (page === 1 && items.length > 0) {
      console.log('DEBUG first item keys:', JSON.stringify(Object.keys(items[0])));
      console.log('DEBUG first item sample:', JSON.stringify(items[0]).slice(0, 800));
    }
    allItems = allItems.concat(items);

    // ST returns hasMore or we infer it from page size
    hasMore = data.hasMore === true || items.length === 500;
    page++;
  }

  return allItems;
}

function getMembershipTypeName(item) {
  // Handle various possible field structures in ST response
  return (
    item.membershipType?.name ||
    item.type?.name ||
    item.membershipTypeName ||
    ''
  );
}

function getSoldByName(item) {
  return (
    item.soldBy?.name ||
    item.createdBy?.name ||
    item.employee?.name ||
    item.completedBy?.name ||
    'Unknown'
  );
}

function filterFreeTypes(items) {
  return items.filter(item => {
    const typeName = getMembershipTypeName(item).toLowerCase();
    return !typeName.includes('free');
  });
}

function processSoldItem(item) {
  return {
    id: item.id,
    soldBy: getSoldByName(item),
    membershipType: getMembershipTypeName(item) || 'Unknown',
    createdOn: item.createdOn || item.startDate,
    customer: item.customer?.name || item.customerName || '',
    status: item.status,
  };
}

function processCancelledItem(item) {
  return {
    id: item.id,
    soldBy: getSoldByName(item),
    membershipType: getMembershipTypeName(item) || 'Unknown',
    cancelledOn:
      item.cancellationDate ||
      item.cancelledOn ||
      item.modifiedOn ||
      item.endDate,
    customer: item.customer?.name || item.customerName || '',
    status: item.status,
  };
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  const { startDate, endDate } = event.queryStringParameters || {};

  if (!startDate || !endDate) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'startDate and endDate query params are required (YYYY-MM-DD)' }),
    };
  }

  if (!process.env.ST_APP_ID || !process.env.ST_CLIENT_SECRET || !process.env.ST_APP_KEY || !process.env.ST_TENANT_ID) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'ServiceTitan environment variables not configured' }),
    };
  }

  try {
    const token = await getAccessToken();

    // Fetch sold (created in range) and cancelled (modified/cancelled in range) in parallel
    const [soldRaw, cancelledRaw] = await Promise.all([
      fetchAllMemberships(token, {
        createdOnOrAfter: `${startDate}T00:00:00Z`,
        createdBefore: `${endDate}T23:59:59Z`,
      }),
      fetchAllMemberships(token, {
        status: 'Canceled',
        modifiedOnOrAfter: `${startDate}T00:00:00Z`,
        modifiedBefore: `${endDate}T23:59:59Z`,
      }),
    ]);

    const sold = filterFreeTypes(soldRaw).map(processSoldItem);
    const cancelled = filterFreeTypes(cancelledRaw).map(processCancelledItem);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        sold,
        cancelled,
        meta: {
          startDate,
          endDate,
          soldCount: sold.length,
          cancelledCount: cancelled.length,
          netGain: sold.length - cancelled.length,
        },
      }),
    };
  } catch (err) {
    console.error('Dashboard function error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
