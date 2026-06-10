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
    allItems = allItems.concat(items);

    // ST returns hasMore or we infer it from page size
    hasMore = data.hasMore === true || items.length === 500;
    page++;
  }

  return allItems;
}

// Build a map of employee ID -> name by fetching from the employees endpoint
async function fetchEmployeeNames(token, ids) {
  if (!ids || ids.length === 0) return {};

  const tenantId = process.env.ST_TENANT_ID;
  const appKey = process.env.ST_APP_KEY;
  const uniqueIds = [...new Set(ids.filter(Boolean))];

  // ServiceTitan employees endpoint (settings/v2)
  const url = new URL(`${ST_API_BASE}/settings/v2/tenant/${tenantId}/employees`);
  url.searchParams.set('pageSize', '500');
  url.searchParams.set('ids', uniqueIds.join(','));

  try {
    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${token}`,
        'ST-App-Key': appKey,
      },
    });

    if (!response.ok) {
      console.warn('Employees endpoint failed:', response.status, await response.text());
      return {};
    }

    const data = await response.json();
    const nameMap = {};
    (data.data || []).forEach(emp => {
      if (emp.id) {
        nameMap[emp.id] = emp.name || `${emp.firstName || ''} ${emp.lastName || ''}`.trim() || String(emp.id);
      }
    });
    return nameMap;
  } catch (err) {
    console.warn('fetchEmployeeNames error:', err.message);
    return {};
  }
}

function getMembershipTypeId(item) {
  return item.membershipTypeId || null;
}

// We can't get membership type names without a separate lookup; use ID for now
// but we'll use it only for "Free" filtering if a name lookup is available
function getMembershipTypeName(item) {
  return (
    item.membershipType?.name ||
    item.type?.name ||
    item.membershipTypeName ||
    ''
  );
}

function getSoldById(item) {
  // Use soldById first, fall back to createdById then activatedById
  return item.soldById || item.createdById || item.activatedById || null;
}

function filterFreeTypes(items) {
  return items.filter(item => {
    const typeName = getMembershipTypeName(item).toLowerCase();
    // If no type name resolved (just an ID), allow through — we can't filter by name
    return !typeName || !typeName.includes('free');
  });
}

function processSoldItem(item, nameMap) {
  const id = getSoldById(item);
  return {
    id: item.id,
    soldBy: (id && nameMap[id]) ? nameMap[id] : 'Unknown',
    membershipType: getMembershipTypeName(item) || `Type #${item.membershipTypeId || '?'}`,
    createdOn: item.createdOn || item.from,
    status: item.status,
  };
}

function processCancelledItem(item, nameMap) {
  const id = getSoldById(item);
  return {
    id: item.id,
    soldBy: (id && nameMap[id]) ? nameMap[id] : 'Unknown',
    membershipType: getMembershipTypeName(item) || `Type #${item.membershipTypeId || '?'}`,
    cancelledOn: item.cancellationDate || item.modifiedOn,
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

    // Fetch sold and cancelled in parallel
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

    // Collect all employee IDs we need to resolve
    const allItems = [...soldRaw, ...cancelledRaw];
    const employeeIds = allItems.map(getSoldById).filter(Boolean);
    const nameMap = await fetchEmployeeNames(token, employeeIds);

    const sold = filterFreeTypes(soldRaw).map(item => processSoldItem(item, nameMap));
    const cancelled = filterFreeTypes(cancelledRaw).map(item => processCancelledItem(item, nameMap));

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
