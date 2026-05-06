/**
 * Tower registry — mirrors config/tower_registry.json from the Architecture repo.
 * Keeps the Input Portal self-contained (no cross-repo dependency at build time).
 */

export interface TowerInfo {
  id: string;
  display: string;
}

export const TOWERS: TowerInfo[] = [
  { id: 'FPR', display: 'Finance, Planning & Reporting' },
  { id: 'OTC-IF', display: 'Order to Cash — Intel Foundry' },
  { id: 'OTC-IP', display: 'Order to Cash — Intel Products' },
  { id: 'FTS-IF', display: 'Fulfill to Ship — Intel Foundry' },
  { id: 'FTS-IP', display: 'Fulfill to Ship — Intel Products' },
  { id: 'PTP', display: 'Procure to Pay' },
  { id: 'MDM', display: 'Master Data Management' },
  { id: 'E2E', display: 'End-to-End Integration' },
];

/**
 * Capability IDs per tower. In the future this will be loaded from the
 * Architecture Portal's capability_master.yaml via API. For now, this is
 * a starter set — easily extended.
 */
export interface CapabilityInfo {
  id: string;
  name: string;
}

export const CAPABILITIES: Record<string, CapabilityInfo[]> = {
  'FPR': [
    // DC — Manage Accounting and Control Data
    { id: 'DC-010', name: 'DC-010 Perform Transaction Processing' },
    { id: 'DC-020', name: 'DC-020 Manage the General Ledger' },
    { id: 'DC-030', name: 'DC-030 Perform Closing' },
    { id: 'DC-040', name: 'DC-040 Perform Fixed Asset Accounting' },
    { id: 'DC-050', name: 'DC-050 Project Accounting' },
    { id: 'DC-060', name: 'DC-060 Manage Taxes' },
    { id: 'DC-100', name: 'DC-100 Revenue Recognition' },
    { id: 'DC-110', name: 'DC-110 Manage Intercompany' },
    { id: 'DC-120', name: 'DC-120 Maintenance & Management Accounting' },
    // DS — Provide Decision Support
    { id: 'DS-010', name: 'DS-010 Perform Overhead Accounting and Allocation' },
    { id: 'DS-020', name: 'DS-020 Perform Product Costing and Inventory Valuation' },
    { id: 'DS-030', name: 'DS-030 Perform Customer and Product Profitability Analysis' },
    // MB — Plan and Manage Business
    { id: 'MB-060', name: 'MB-060 Plan the Business' },
    { id: 'MB-070', name: 'MB-070 Prepare Budgets' },
    // MR — Manage Capital and Risk
    { id: 'MR-010', name: 'MR-010 Manage Liquidity' },
    { id: 'MR-020', name: 'MR-020 Manage Capital Structure' },
    { id: 'MR-030', name: 'MR-030 Manage Financial Risk' },
    { id: 'MR-070', name: 'MR-070 In-House Banking' },
    // OR — Receivables Management
    { id: 'OR-140', name: 'OR-140 Process Receipts' },
  ],
  'OTC-IF': [
    { id: 'L-010', name: 'L-010 Sales Order Management' },
    { id: 'L-020', name: 'L-020 Pricing & Conditions' },
    { id: 'L-030', name: 'L-030 Credit Management' },
    { id: 'L-040', name: 'L-040 Billing & Invoicing' },
    { id: 'L-050', name: 'L-050 Revenue Accounting' },
    { id: 'L-060', name: 'L-060 GTS Export Compliance' },
  ],
  'OTC-IP': [
    { id: 'L-010', name: 'L-010 Sales Order Management' },
    { id: 'L-020', name: 'L-020 Pricing & Conditions' },
    { id: 'L-030', name: 'L-030 Credit Management' },
    { id: 'L-040', name: 'L-040 Billing & Invoicing' },
    { id: 'L-050', name: 'L-050 Revenue Accounting' },
    { id: 'L-060', name: 'L-060 GTS Export Compliance' },
    { id: 'L-070', name: 'L-070 Returns & Refunds' },
  ],
  'FTS-IF': [
    { id: 'L-040', name: 'L-040 Outbound Logistics' },
    { id: 'LO-060', name: 'LO-060 EWM / Warehousing' },
    { id: 'LO-080', name: 'LO-080 Transportation Management' },
    { id: 'LO-100', name: 'LO-100 Manufacturing Execution' },
    { id: 'LO-120', name: 'LO-120 MRP / Demand Planning' },
    { id: 'LO-140', name: 'LO-140 Plant Maintenance' },
    { id: 'LO-160', name: 'LO-160 Quality Management' },
  ],
  'FTS-IP': [
    { id: 'L-040', name: 'L-040 Outbound Logistics' },
    { id: 'LO-060', name: 'LO-060 EWM / Warehousing' },
    { id: 'LO-080', name: 'LO-080 Transportation Management' },
    { id: 'LO-100', name: 'LO-100 Manufacturing Execution' },
    { id: 'LO-120', name: 'LO-120 MRP / Demand Planning' },
  ],
  'PTP': [
    { id: 'P-010', name: 'P-010 Procurement' },
    { id: 'P-020', name: 'P-020 Purchase Orders' },
    { id: 'P-030', name: 'P-030 Goods Receipt' },
    { id: 'P-040', name: 'P-040 Invoice Verification' },
    { id: 'P-050', name: 'P-050 Payments' },
    { id: 'P-060', name: 'P-060 GTS Import Compliance' },
    { id: 'L-040', name: 'L-040 Inbound Logistics' },
    { id: 'LO-160', name: 'LO-160 Quality Management' },
  ],
  'MDM': [
    { id: 'MD-010', name: 'MD-010 Material Master' },
    { id: 'MD-020', name: 'MD-020 Customer Master' },
    { id: 'MD-030', name: 'MD-030 Vendor Master' },
    { id: 'MD-040', name: 'MD-040 BOM Management' },
  ],
  'E2E': [
    { id: 'E2E-10', name: 'E2E-10 Cross-Tower Integration' },
    { id: 'E2E-20', name: 'E2E-20 Data Hub' },
    { id: 'E2E-30', name: 'E2E-30 Middleware / Integration Platform' },
    { id: 'E2E-40', name: 'E2E-40 Reporting & Analytics' },
    { id: 'E2E-80', name: 'E2E-80 Security & Compliance' },
  ],
};
