const hubspot = require('@hubspot/api-client');
const { queue } = require('async');
const _ = require('lodash');
const mongoose = require('mongoose');

const { filterNullValuesFromObject, goal } = require('./utils');
const Domain = require('./Domain');

console.log('Starting script...');

// Load environment variables
require('dotenv').config();

// Validate environment variables
const requiredEnvVars = ['MONGO_URI', 'HUBSPOT_CS'];
const missingEnvVars = requiredEnvVars.filter(varName => !process.env[varName]);
if (missingEnvVars.length > 0) {
  console.error('Missing required environment variables:', missingEnvVars);
  process.exit(1);
}

console.log('Environment variables loaded and validated');

// Initialize HubSpot client with empty access token (will be set per account)
const hubspotClient = new hubspot.Client();
console.log('HubSpot client initialized');

// Add debug logging for MongoDB connection
console.log('Attempting to connect to MongoDB...');
mongoose.connect(process.env.MONGO_URI)
  .then(() => {
    console.log('Connected to MongoDB');
    console.log('Starting data pull...');
    return pullDataFromHubspot();
  })
  .catch(err => {
    console.error('MongoDB connection error:', err);
    process.exit(1);
  });

const propertyPrefix = 'hubspot__';

const generateLastModifiedDateFilter = (date, nowDate, propertyName = 'hs_lastmodifieddate') => {
  const lastModifiedDateFilter = date ?
    {
      filters: [
        { propertyName, operator: 'GTE', value: `${date.valueOf()}` },
        { propertyName, operator: 'LTE', value: `${nowDate.valueOf()}` }
      ]
    } :
    {};

  return lastModifiedDateFilter;
};

const saveDomain = async domain => {
  // disable this for testing purposes
  return;

  domain.markModified('integrations.hubspot.accounts');
  await domain.save();
};

/**
 * Get access token from HubSpot
 */
const refreshAccessToken = async (account) => {
  console.log('Attempting to refresh access token...');
  const { HUBSPOT_CID, HUBSPOT_CS } = process.env;
  
  if (!account.refreshToken) {
    console.error('Account data:', JSON.stringify(account, null, 2));
    throw new Error('No refresh token found in account');
  }

  try {
    console.log('Making token refresh API call...');
    const result = await hubspotClient.oauth.tokensApi
      .createToken('refresh_token', undefined, undefined, HUBSPOT_CID, HUBSPOT_CS, account.refreshToken);
    
    console.log('Token refresh API call successful');
    const body = result.body ? result.body : result;

    if (!body || !body.accessToken) {
      console.error('Invalid response from HubSpot:', body);
      throw new Error('Invalid response from HubSpot token refresh');
    }

    const newAccessToken = body.accessToken;
    hubspotClient.setAccessToken(newAccessToken);
    account.accessToken = newAccessToken;

    return true;
  } catch (err) {
    console.error('Error refreshing token:', err);
    throw err;
  }
};

/**
 * Get recently modified companies as 100 companies per page
 */
const processCompanies = async (domain, hubId, q) => {
  const account = domain.integrations.hubspot.accounts.find(account => account.hubId === hubId);
  const lastPulledDate = new Date(account.lastPulledDates.companies);
  const now = new Date();

  let hasMore = true;
  const offsetObject = {};
  const limit = 100;

  while (hasMore) {
    const lastModifiedDate = offsetObject.lastModifiedDate || lastPulledDate;
    const lastModifiedDateFilter = generateLastModifiedDateFilter(lastModifiedDate, now);
    const searchObject = {
      filterGroups: [lastModifiedDateFilter],
      sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'ASCENDING' }],
      properties: [
        'name',
        'domain',
        'country',
        'industry',
        'description',
        'annualrevenue',
        'numberofemployees',
        'hs_lead_status'
      ],
      limit,
      after: offsetObject.after
    };

    let searchResult = {};

    try {
      searchResult = await hubspotClient.crm.companies.searchApi.doSearch(searchObject);
    } catch (err) {
      console.error('Error fetching companies:', err);
      throw err;
    }

    const data = searchResult?.results || [];
    offsetObject.after = parseInt(searchResult?.paging?.next?.after);

    console.log('fetch company batch');

    data.forEach(company => {
      if (!company.properties) return;

      const actionTemplate = {
        includeInAnalytics: 0,
        companyProperties: {
          company_id: company.id,
          company_domain: company.properties.domain,
          company_industry: company.properties.industry
        }
      };

      const isCreated = !lastPulledDate || (new Date(company.createdAt) > lastPulledDate);

      q.push({
        actionName: isCreated ? 'Company Created' : 'Company Updated',
        actionDate: new Date(isCreated ? company.createdAt : company.updatedAt) - 2000,
        ...actionTemplate
      });
    });

    if (!offsetObject?.after) {
      hasMore = false;
      break;
    } else if (offsetObject?.after >= 9900) {
      offsetObject.after = 0;
      offsetObject.lastModifiedDate = new Date(data[data.length - 1].updatedAt).valueOf();
    }
  }

  account.lastPulledDates.companies = now;
  await saveDomain(domain);

  return true;
};

/**
 * Get recently modified contacts as 100 contacts per page
 */
const processContacts = async (domain, hubId, q) => {
  const account = domain.integrations.hubspot.accounts.find(account => account.hubId === hubId);
  const lastPulledDate = new Date(account.lastPulledDates.contacts);
  const now = new Date();

  let hasMore = true;
  const offsetObject = {};
  const limit = 100;

  while (hasMore) {
    const lastModifiedDate = offsetObject.lastModifiedDate || lastPulledDate;
    const lastModifiedDateFilter = generateLastModifiedDateFilter(lastModifiedDate, now, 'lastmodifieddate');
    const searchObject = {
      filterGroups: [lastModifiedDateFilter],
      sorts: [{ propertyName: 'lastmodifieddate', direction: 'ASCENDING' }],
      properties: [
        'firstname',
        'lastname',
        'jobtitle',
        'email',
        'hubspotscore',
        'hs_lead_status',
        'hs_analytics_source',
        'hs_latest_source'
      ],
      limit,
      after: offsetObject.after
    };

    let searchResult = {};

    try {
      searchResult = await hubspotClient.crm.contacts.searchApi.doSearch(searchObject);
    } catch (err) {
      console.error('Error fetching contacts:', err);
      throw err;
    }

    const data = searchResult.results || [];

    console.log('fetch contact batch');

    offsetObject.after = parseInt(searchResult.paging?.next?.after);
    const contactIds = data.map(contact => contact.id);

    // contact to company association
    const contactsToAssociate = contactIds;
    const companyAssociationsResults = (await (await hubspotClient.apiRequest({
      method: 'post',
      path: '/crm/v3/associations/CONTACTS/COMPANIES/batch/read',
      body: { inputs: contactsToAssociate.map(contactId => ({ id: contactId })) }
    })).json())?.results || [];

    const companyAssociations = Object.fromEntries(companyAssociationsResults.map(a => {
      if (a.from) {
        contactsToAssociate.splice(contactsToAssociate.indexOf(a.from.id), 1);
        return [a.from.id, a.to[0].id];
      } else return false;
    }).filter(x => x));

    data.forEach(contact => {
      if (!contact.properties || !contact.properties.email) return;

      const companyId = companyAssociations[contact.id];

      const isCreated = new Date(contact.createdAt) > lastPulledDate;

      const userProperties = {
        company_id: companyId,
        contact_name: ((contact.properties.firstname || '') + ' ' + (contact.properties.lastname || '')).trim(),
        contact_title: contact.properties.jobtitle,
        contact_source: contact.properties.hs_analytics_source,
        contact_status: contact.properties.hs_lead_status,
        contact_score: parseInt(contact.properties.hubspotscore) || 0
      };

      const actionTemplate = {
        includeInAnalytics: 0,
        identity: contact.properties.email,
        userProperties: filterNullValuesFromObject(userProperties)
      };

      q.push({
        actionName: isCreated ? 'Contact Created' : 'Contact Updated',
        actionDate: new Date(isCreated ? contact.createdAt : contact.updatedAt),
        ...actionTemplate
      });
    });

    if (!offsetObject?.after) {
      hasMore = false;
      break;
    } else if (offsetObject?.after >= 9900) {
      offsetObject.after = 0;
      offsetObject.lastModifiedDate = new Date(data[data.length - 1].updatedAt).valueOf();
    }
  }

  account.lastPulledDates.contacts = now;
  await saveDomain(domain);

  return true;
};

/**
 * Get recently modified meetings as 100 meetings per page
 */
const processMeetings = async (domain, hubId, q) => {
  const account = domain.integrations.hubspot.accounts.find(account => account.hubId === hubId);
  const lastPulledDate = new Date(account.lastPulledDates.meetings);
  const now = new Date();

  let hasMore = true;
  const offsetObject = {};
  const limit = 100;

  while (hasMore) {
    const lastModifiedDate = offsetObject.lastModifiedDate || lastPulledDate;
    const lastModifiedDateFilter = generateLastModifiedDateFilter(lastModifiedDate, now);
    const searchObject = {
      filterGroups: [lastModifiedDateFilter],
      sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'ASCENDING' }],
      properties: [
        'hs_meeting_title',
        'hs_meeting_body',
        'hs_meeting_start_time',
        'hs_meeting_end_time',
        'hs_meeting_outcome'
      ],
      limit,
      after: offsetObject.after
    };

    let searchResult = {};

    try {
      searchResult = await hubspotClient.crm.objects.meetings.searchApi.doSearch(searchObject);
    } catch (err) {
      console.error('Error fetching meetings:', err);
      throw err;
    }

    const data = searchResult?.results || [];
    offsetObject.after = parseInt(searchResult?.paging?.next?.after);

    console.log('fetch meeting batch');

    // Get meeting-contact associations for all meetings in the batch
    const meetingIds = data.map(meeting => meeting.id);
    const meetingAssociationsResults = (await (await hubspotClient.apiRequest({
      method: 'post',
      path: '/crm/v3/associations/MEETINGS/CONTACTS/batch/read',
      body: { inputs: meetingIds.map(meetingId => ({ id: meetingId })) }
    })).json())?.results || [];

    // For each meeting with contacts, get the contact details to get their email
    const contactPromises = meetingAssociationsResults.map(async (association) => {
      if (!association.to || !association.to.length) return null;
      
      const contactId = association.to[0].id;
      try {
        const contact = await hubspotClient.crm.contacts.basicApi.getById(
          contactId,
          ['email']
        );
        return {
          meetingId: association.from.id,
          contactEmail: contact.properties.email
        };
      } catch (err) {
        console.error(`Failed to fetch contact details for meeting ${association.from.id}:`, err);
        return null;
      }
    });

    const meetingContacts = (await Promise.all(contactPromises))
      .filter(result => result !== null)
      .reduce((acc, { meetingId, contactEmail }) => {
        acc[meetingId] = contactEmail;
        return acc;
      }, {});

    data.forEach(meeting => {
      if (!meeting.properties) return;

      const contactEmail = meetingContacts[meeting.id];
      if (!contactEmail) return; // Skip meetings without associated contacts

      const meetingProperties = {
        meeting_id: meeting.id,
        meeting_title: meeting.properties.hs_meeting_title,
        meeting_start_time: meeting.properties.hs_meeting_start_time,
        meeting_end_time: meeting.properties.hs_meeting_end_time,
        meeting_outcome: meeting.properties.hs_meeting_outcome
      };

      const isCreated = !lastPulledDate || (new Date(meeting.createdAt) > lastPulledDate);

      const actionTemplate = {
        includeInAnalytics: 0,
        identity: contactEmail,
        userProperties: filterNullValuesFromObject(meetingProperties)
      };

      q.push({
        actionName: isCreated ? 'Meeting Created' : 'Meeting Updated',
        actionDate: new Date(isCreated ? meeting.createdAt : meeting.updatedAt),
        ...actionTemplate
      });
    });

    if (!offsetObject?.after) {
      hasMore = false;
      break;
    } else if (offsetObject?.after >= 9900) {
      offsetObject.after = 0;
      offsetObject.lastModifiedDate = new Date(data[data.length - 1].updatedAt).valueOf();
    }
  }

  account.lastPulledDates.meetings = now;
  await saveDomain(domain);

  return true;
};

const createQueue = (domain, actions) => queue(async (action, callback) => {
  actions.push(action);

  if (actions.length > 2000) {
    console.log('inserting actions to database', { apiKey: domain.apiKey, count: actions.length });

    const copyOfActions = _.cloneDeep(actions);
    actions.splice(0, actions.length);

    goal(copyOfActions);
  }

  callback();
}, 100000000);

const drainQueue = async (domain, actions, q) => {
  if (q.length() > 0) await q.drain();

  if (actions.length > 0) {
    goal(actions)
  }

  return true;
};

const pullDataFromHubspot = async () => {
  console.log('Inside pullDataFromHubspot function');
  try {
    const domains = await Domain.find({
      'integrations.hubspot.status': true
    });
    
    console.log(`Found ${domains.length} domains with HubSpot integration enabled`);
    
    if (domains.length === 0) {
      console.log('No domains found with HubSpot integration enabled. Exiting...');
      process.exit(0);
    }
    
    for (const domain of domains) {
      console.log(`Processing domain: ${domain.company?.name || 'Unknown Company'}`);
      console.log('Domain data:', JSON.stringify(domain.integrations?.hubspot, null, 2));
      
      const actions = [];
      const q = createQueue(domain, actions);

      if (!domain.integrations?.hubspot?.accounts?.length) {
        console.log('No HubSpot accounts found for domain. Skipping...');
        continue;
      }

      for (const account of domain.integrations.hubspot.accounts) {
        console.log(`Processing HubSpot account: ${account.hubId}`);
        
        try {
          await refreshAccessToken(account);
          console.log('Access token refreshed successfully');
        } catch (err) {
          console.error('Error refreshing access token:', err);
          continue;
        }

        try {
          await processContacts(domain, account.hubId, q);
          console.log('process contacts');
        } catch (err) {
          console.log(err, { apiKey: domain.apiKey, metadata: { operation: 'processContacts', hubId: account.hubId } });
        }

        try {
          await processCompanies(domain, account.hubId, q);
          console.log('process companies');
        } catch (err) {
          console.log(err, { apiKey: domain.apiKey, metadata: { operation: 'processCompanies', hubId: account.hubId } });
        }

        try {
          await processMeetings(domain, account.hubId, q);
          console.log('process meetings');
        } catch (err) {
          console.log(err, { apiKey: domain.apiKey, metadata: { operation: 'processMeetings', hubId: account.hubId } });
        }

        try {
          await drainQueue(domain, actions, q);
          console.log('drain queue');
        } catch (err) {
          console.log(err, { apiKey: domain.apiKey, metadata: { operation: 'drainQueue', hubId: account.hubId } });
        }

        await saveDomain(domain);

        console.log('finish processing account');
      }

      console.log('finish processing domain');
    }

    process.exit();
  } catch (err) {
    console.error('Error in pullDataFromHubspot:', err);
    process.exit(1);
  }
};

module.exports = pullDataFromHubspot;