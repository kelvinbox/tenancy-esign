/*
 * Invented data for demo mode. None of these people, properties, emails or numbers are real.
 * In live use the Tenant Management app would supply these values.
 */
var DemoData = {
  landlords: [
    {
      name: 'Owner Family Trust', email: 'sam.owner@example.com',
      phone: '03 000 0100', mobile: '021 000 0100', addressForService: '9 Sample Terrace, Maori Hill, Dunedin',
      signers: [
        { name: 'Sam Owner', email: 'sam.owner@example.com', mobile: '021 000 0100' },
        { name: 'Pat Owner', email: 'pat.owner@example.com', mobile: '022 000 0200' }
      ]
    },
    {
      name: 'Pat Owner', email: 'pat.owner@example.com',
      phone: '', mobile: '022 000 0200', addressForService: '9 Sample Terrace, Maori Hill, Dunedin',
      signers: [{ name: 'Pat Owner', email: 'pat.owner@example.com', mobile: '022 000 0200' }]
    }
  ],
  properties: [
    {
      id: 'P1', name: 'Kowhai Lane', address: '14 Kowhai Lane, Roslyn, Dunedin', rent: '650', bond: '2600', maxOccupants: 3,
      tenancyLength: '12 months', landlord: 'Owner Family Trust',
      insurer: 'Example Insurance Ltd', insurancePolicy: 'EX-HOME-000123', excess: '500', insulationDate: '2025-03-12',
      insulationStatement: 'Ceiling: 190mm glass wool batts, full coverage, good condition. Underfloor: polystyrene panels, good condition. Walls: unknown (landlord has made reasonable efforts to find out).',
      chattels: 'Fridge, washing machine, curtains in every room, heat pump (living room)'
    },
    {
      id: 'P2', name: 'Totara Street flat', address: '3/88 Totara Street, North East Valley, Dunedin', rent: '480.50', bond: '1922', maxOccupants: 2,
      tenancyLength: 'Periodic', landlord: 'Pat Owner',
      insurer: 'Not insured', insurancePolicy: '', excess: '', insulationDate: '2024-11-02',
      insulationStatement: 'Ceiling: 140mm polyester blanket, good condition. Underfloor: foil-backed polystyrene, good condition.',
      chattels: 'Oven, rangehood, blinds'
    }
  ],
  groups: [
    {
      key: 'KB-20031', property: 'P1', label: 'Mia, T\u016bi and Jordan (approved)',
      tenants: [
        { ref: 'KB-20031', name: 'Mia Example', email: 'mia@example.com', mobile: '021 000 1001', idType: 'Driver licence', idNumber: 'DX000001', dob: '2001-05-04' },
        { ref: 'KB-20032', name: 'T\u016bi Sample', email: 'tui@example.net', mobile: '021 000 1002', idType: 'Passport', idNumber: 'LA000002', dob: '2000-01-02' },
        { ref: 'KB-20033', name: 'Jordan Test', email: 'jordan@example.org', mobile: '021 000 1003', idType: 'Driver licence', idNumber: 'DX000003', dob: '2003-02-10' }
      ]
    },
    {
      key: 'KB-20040', property: 'P2', label: 'Alex Placeholder (approved)',
      tenants: [
        { ref: 'KB-20040', name: 'Alex Placeholder', email: 'alex@example.com', mobile: '027 000 2001', idType: 'Driver licence', idNumber: 'DX000040', dob: '1995-09-30' }
      ]
    }
  ],
  // Approved applicants who can join an existing tenancy (filling a room or replacing someone).
  applicants: [
    { ref: 'KB-20050', name: 'Riley Sample', email: 'riley@example.com', mobile: '021 000 1050', idType: 'Driver licence', idNumber: 'DX000050', dob: '1999-07-07' },
    { ref: 'KB-20051', name: 'Casey Demo', email: 'casey@example.net', mobile: '022 000 1051', idType: 'Passport', idNumber: 'LA000051', dob: '2001-11-20' }
  ],
  rentPaymentDetails: 'Automatic payment to Owner Family Trust, account 00-0000-0000000-00 (fake), reference: your surname',
  healthyHomesStatement: 'The landlord complies with the healthy homes standards for heating, insulation, ventilation, moisture ingress and drainage, and draught stopping. ' +
    'Heating: 6kW heat pump in the living room. Ventilation: extractor fans in the kitchen and bathroom vent outside; every habitable room has an opening window. ' +
    'Moisture: a ground moisture barrier is installed under the floor and gutters drain properly. Draught stopping: no unreasonable gaps or holes.'
};
