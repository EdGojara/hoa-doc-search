// Renders sample HTML for the Annual Meeting Notice for both Canyon Gate
// (online voting on, floor noms off, 1 seat, 3-year term, TX 209 callout)
// and Waterview Estates (no online voting, floor noms on, 2 seats, embedded
// TX 209) so Ed can compare against the originals.

const fs = require('fs');
const path = require('path');
const { renderAnnualMeetingNoticeHTML } = require('../lib/nominations/annual_meeting_notice');

// =========================== CANYON GATE SAMPLE ===========================
const canyonGate = {
  cycle: {
    community_name: 'Canyon Gate at Cinco Ranch',
    association_legal_name: 'Canyon Gate at Cinco Ranch Association, Inc.',
    annual_meeting_date: '2026-05-27',
    annual_meeting_time: '6:30 PM',
    annual_meeting_location: 'Canyon Gate Rec Center, 20422 Canyon Gate Blvd, Katy, TX 77450',
    seats_open: 1,
    floor_nominations_policy: 'not_allowed',
  },
  candidates: [
    {
      nominee_name: 'Muhammad Akhtar',
      years_in_community: '2006',
      nominee_bio: 'Hello, my name is Muhammad Akhtar. I have been a dedicated homeowner living here since 2006. I have strong leadership skills along with financial and community service experience. I have served on boards and volunteer organizations. As a realtor, I understand the importance of responsible decision making to protect property values. I am committed to helping make Canyon Gate a safe place.',
    },
    {
      nominee_name: 'Hugh Durlam',
      is_incumbent: true,
      years_in_community: '2005',
      nominee_bio: "My family and I have called Canyon Gate home since 2005. I believe that being part of a community means more than just living in — it means serving it. With over sixteen years of experience in business development and project management within the AEC (Architecture, Engineering, and Construction) industry, I bring a technical and strategic perspective to our board.\n\nBeyond my professional background, I am a graduate of the Fort Bend Leadership program and Commissioner's College, and I recently achieved my certification in mediation for the State of Texas.\n\nSince joining the board in 2019, I have overseen numerous construction projects, amenity upgrades, and cherished community events. My goal is to use my professional talents to ensure Canyon Gate remains modern, financially sound, and well-maintained.",
    },
    {
      nominee_name: 'Ivan Ray',
      years_in_community: '2016',
      nominee_bio: "Hi! My name is Ivan Ray. I've been part of this community since 2016 and have a strong interest in maintaining and improving the quality of our neighborhood. For over 10 years, I've worked as a Machine Shop Supervisor, where I'm responsible for managing operations, coordinating work, and making sure projects are completed efficiently and correctly. In addition, I've spent over a year as a Scouts USA Assistant Scoutmaster and over three years as a Scouts USA Den Leader. If elected, I will focus on being responsive, practical, and committed to doing the work.",
    },
    {
      nominee_name: 'Fiona Setna',
      years_in_community: '1999',
      nominee_bio: "Hello my name is Fiona Setna. I am a teacher in Katy ISD. I have a B.S. in Psychology with a minor in Sociology and a master's in education-Curriculum and Instruction. I have proudly been a resident of this neighborhood since 1999, and over the years it has truly become home to me. I care deeply about our community and value a well-maintained neighborhood where residents feel comfortable, proud and heard.",
    },
    {
      nominee_name: 'Abdul Syed',
      years_in_community: '2023',
      nominee_bio: "I'm Abdul Syed, and I've been a homeowner at Canyon Gate for the past 3 years. Professionally, I serve as SVP of Product Management, and I hold an MS and MBA from LSU. My prior board experience includes serving as a Board Advisor for the USF College of Business / Marketing program. I'm running because I believe my experience can bring a new perspective to the Board. I also believe HOA boards should operate with transparency and open communication.",
    },
  ],
  voting_methods: {
    online: {
      enabled: true,
      close_date: '2026-05-22',
      close_time: '4:00 PM',
    },
    mail: {
      enabled: true,
      receive_by_date: '2026-05-22',
      receive_by_time: '4:00 PM',
      return_address: 'Bedrock Association Management, 12808 West Airport Blvd, Ste 253, Sugar Land, TX 77478',
    },
    email: {
      enabled: true,
      receive_by_date: '2026-05-22',
      receive_by_time: '4:00 PM',
      address: 'propertymanager@canyongateatcincoranch.com',
    },
    drop_off: {
      enabled: true,
      receive_by_date: '2026-05-22',
      receive_by_time: '4:00 PM',
      location_name: 'Canyon Gate Rec Center',
      location_address: '20422 Canyon Gate Blvd, Katy, TX 77450',
    },
    in_person: {
      enabled: true,
    },
  },
  options: {
    term_years: 3,
    tx_209_disclosure: 'callout',
    floor_nominations: 'not_allowed',
  },
};

// =========================== WATERVIEW SAMPLE =============================
const waterview = {
  cycle: {
    community_name: 'Waterview Estates',
    association_legal_name: "Waterview Estates Owners' Association, Inc.",
    annual_meeting_date: '2024-06-18',
    annual_meeting_time: '6:00 PM',
    annual_meeting_location: '5110 Waterview Estates Trail, Richmond, TX 77407',
    seats_open: 2,
    floor_nominations_policy: 'allowed',
  },
  candidates: [
    {
      nominee_name: 'Drona Gautam',
      is_incumbent: true,
      years_in_community: '10 years',
      nominee_bio: "Background: My name is Drona Gautam, living in this community for last 10 years with my wife and 2 beautiful children. I am currently employed as an Executive Director of a non-profit community health and dental care center having multiple locations around the state of Texas.\n\nHobbies: I have spent much of my time volunteering with various non-profit organizations. I am currently performing my duties as a Vice President of the Nepalese Association of Houston for the second term.\n\nWhy You Are Running: I am always enthused to do whatever I can to help the people I am associated with. I believe I will be a very capable person to accomplish the tasks related to representing my fellow homeowners.",
    },
    {
      nominee_name: 'Alexis Geissler',
      is_incumbent: true,
      years_in_community: '12 years',
      nominee_bio: "I have lived in Waterview Estates for almost 12 years. I live here with my husband Brett, my son Owen (16) and my daughter Madeline (14). I am also a local business owner.\n\nI have had the pleasure of serving on the HOA Board for 9½ years and am currently serving as your President. During my time on the Board, I have helped lead the developer transition, made sure our financials are properly done, kept the community clean and well-maintained, ensured amenities are upgraded as necessary, and vetted and replaced vendors.\n\nWhen I ran for the Board originally in 2014, I shared three goals: greater transparency, strong accountability, and increased community involvement. Through dedication and strong partnerships, we have been able to meet these goals.",
    },
    {
      nominee_name: 'Claudia Hipps',
      years_in_community: '9 years',
      nominee_bio: "Howdy, my name is Claudia Hipps. We started building our home in Waterview Estates in November 2014. My husband and I have been together for almost 20 years. I work remotely for the Security & Exchange Commission of the United States of America. This spring I began my master's in law at A&M Law School. I am among the first ten Board Certified Paralegals in Criminal Law by the Texas Board of Legal Specialization. I am running for a position on the HOA Board to continue finding ways to bring our community together.",
    },
    {
      nominee_name: 'Yasir Khan',
      years_in_community: null,
      nominee_bio: null,
    },
    {
      nominee_name: 'Scott Malloy',
      years_in_community: '8 years',
      nominee_bio: "I am excited to announce my candidacy for the HOA board position. My name is Scott Malloy, and I have been a proud resident of Waterview for the past eight years. I live here with my wife Melissa and our three children, Blake, Brayden, and Mackenzie. Since 2019, I have been an active and dedicated member of our community, volunteering on the school's PTO. As a successful small business owner, I bring valuable experience in management and organization.",
    },
  ],
  voting_methods: {
    online: { enabled: false },
    mail: {
      enabled: true,
      receive_by_date: '2024-06-12',
      receive_by_time: '12:00 PM',
      return_address: '5110 Waterview Estates Trail, Richmond, TX 77407',
    },
    email: {
      enabled: true,
      receive_by_date: '2024-06-12',
      receive_by_time: '12:00 PM',
      address: 'mkessler@bedrocktx.com',
    },
    drop_off: {
      enabled: true,
      receive_by_date: '2024-06-12',
      receive_by_time: '12:00 PM',
      location_name: 'Waterview Estates On-Site Office',
    },
    in_person: { enabled: true },
  },
  options: {
    term_years: 2,
    tx_209_disclosure: 'embedded',
    floor_nominations: 'allowed',
    registration_time: '5:45 PM',
    voting_year: 2024,
  },
};

async function main() {
  const downloads = path.join(process.env.USERPROFILE || process.env.HOME || '.', 'Downloads');
  if (!fs.existsSync(downloads)) fs.mkdirSync(downloads, { recursive: true });

  const cgHtml = await renderAnnualMeetingNoticeHTML(canyonGate);
  const cgPath = path.join(downloads, 'PREVIEW_Annual_Meeting_Canyon_Gate_2026.html');
  fs.writeFileSync(cgPath, cgHtml, 'utf8');

  const wvHtml = await renderAnnualMeetingNoticeHTML(waterview);
  const wvPath = path.join(downloads, 'PREVIEW_Annual_Meeting_Waterview_2024.html');
  fs.writeFileSync(wvPath, wvHtml, 'utf8');

  console.log('Canyon Gate preview:  ' + cgPath);
  console.log('Waterview preview:    ' + wvPath);
}

main().catch((e) => { console.error(e); process.exit(1); });
