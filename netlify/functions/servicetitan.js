// netlify/functions/servicetitan.js
// ServiceTitan Membership Dashboard - Data Proxy Function

const ST_AUTH_URL = 'https://auth.servicetitan.io/connect/token';
const ST_API_BASE = 'https://api.servicetitan.io';

// In-memory token cache (resets on cold start)
// Set to null to force refresh and pick up any new API scopes
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
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

function stHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'ST-App-Key': process.env.ST_APP_KEY,
  };
}

async function fetchAllMemberships(token, queryParams) {
  const tenantId = process.env.ST_TENANT_ID;
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

    const response = await fetch(url.toString(), { headers: stHeaders(token) });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`ServiceTitan API error (${response.status}): ${text}`);
    }

    const data = await response.json();
    const items = data.data || [];
    allItems = allItems.concat(items);
    hasMore = data.hasMore === true || items.length === 500;
    page++;
  }

  return allItems;
}

// Fetch membership type names — we have "Read: Membership Types" scope
async function fetchMembershipTypeNames(token, ids) {
  if (!ids || ids.length === 0) return {};
  const tenantId = process.env.ST_TENANT_ID;
  const uniqueIds = [...new Set(ids.filter(Boolean))];

  try {
    const url = new URL(`${ST_API_BASE}/memberships/v2/tenant/${tenantId}/membership-types`);
    url.searchParams.set('pageSize', '500');
    url.searchParams.set('ids', uniqueIds.join(','));

    const response = await fetch(url.toString(), { headers: stHeaders(token) });
    if (!response.ok) {
      console.warn('MembershipTypes lookup failed:', response.status);
      return {};
    }

    const data = await response.json();
    const map = {};
    (data.data || []).forEach(t => {
      if (t.id) map[t.id] = t.name || String(t.id);
    });
    return map;
  } catch (err) {
    console.warn('fetchMembershipTypeNames error:', err.message);
    return {};
  }
}

// Fetch all employees/technicians and build an ID->name map
async function fetchAllFromEndpoint(token, url) {
  const allItems = [];
  let page = 1;
  let hasMore = true;
  while (hasMore && page <= 5) {
    url.searchParams.set('page', page.toString());
    const response = await fetch(url.toString(), { headers: stHeaders(token) });
    if (!response.ok) {
      const text = await response.text();
      console.warn(`Endpoint failed (${response.status}):`, text.slice(0, 200));
      return null; // signal failure
    }
    const data = await response.json();
    const items = data.data || [];
    allItems.push(...items);
    hasMore = data.hasMore === true || items.length === 500;
    page++;
  }
  return allItems;
}

// Try to resolve employee names — fetches all employees, then all technicians
async function fetchEmployeeNames(token) {
  const tenantId = process.env.ST_TENANT_ID;
  const map = {};

  const endpoints = [
    `${ST_API_BASE}/settings/v2/tenant/${tenantId}/employees`,
    `${ST_API_BASE}/settings/v2/tenant/${tenantId}/technicians`,
  ];

  for (const base of endpoints) {
    try {
      const url = new URL(base);
      url.searchParams.set('pageSize', '500');
      url.searchParams.set('active', 'true');
      const items = await fetchAllFromEndpoint(token, url);
      if (items && items.length > 0) {
        items.forEach(emp => {
          if (emp.id) {
            map[emp.id] = emp.name ||
              `${emp.firstName || ''} ${emp.lastName || ''}`.trim() ||
              String(emp.id);
          }
        });
        console.log(`Loaded ${items.length} records from ${base}`);
      }
    } catch (err) {
      console.warn('fetchEmployeeNames error:', err.message);
    }
  }

  return map;
}

function getSoldById(item) {
  return item.soldById || item.createdById || item.activatedById || null;
}

function filterFreeTypes(items, typeNameMap) {
  return items.filter(item => {
    // Check embedded name first, then look up in our map
    const embeddedName = (
      item.membershipType?.name ||
      item.type?.name ||
      item.membershipTypeName ||
      ''
    ).toLowerCase();
    if (embeddedName) return !embeddedName.includes('free');

    const mappedName = (typeNameMap[item.membershipTypeId] || '').toLowerCase();
    return !mappedName.includes('free');
  });
}

function getTypeName(item, typeNameMap) {
  return (
    item.membershipType?.name ||
    item.type?.name ||
    item.membershipTypeName ||
    typeNameMap[item.membershipTypeId] ||
    `Type #${item.membershipTypeId || '?'}`
  );
}

function getSoldByName(item, nameMap) {
  const id = getSoldById(item);
  if (!id) return 'Unknown';
  return nameMap[id] || `Employee #${id}`;
}

function processSoldItem(item, nameMap, typeNameMap) {
  return {
    id: item.id,
    soldBy: getSoldByName(item, nameMap),
    membershipType: getTypeName(item, typeNameMap),
    createdOn: item.createdOn || item.from,
    status: item.status,
  };
}

function processCancelledItem(item, nameMap, typeNameMap) {
  return {
    id: item.id,
    soldBy: getSoldByName(item, nameMap),
    membershipType: getTypeName(item, typeNameMap),
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
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const { startDate, endDate } = event.queryStringParameters || {};

  if (!startDate || !endDate) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'startDate and endDate query params required (YYYY-MM-DD)' }),
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

    const allItems = [...soldRaw, ...cancelledRaw];

    // Collect type IDs to look up
    const typeIds = allItems.map(i => i.membershipTypeId).filter(Boolean);

    // Fetch lookup maps in parallel (employee fetch gets all, no ID filter needed)
    const [nameMap, typeNameMap] = await Promise.all([
      fetchEmployeeNames(token),
      fetchMembershipTypeNames(token, typeIds),
    ]);

    const sold = filterFreeTypes(soldRaw, typeNameMap).map(item => processSoldItem(item, nameMap, typeNameMap));
    const cancelled = filterFreeTypes(cancelledRaw, typeNameMap).map(item => processCancelledItem(item, nameMap, typeNameMap));

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
