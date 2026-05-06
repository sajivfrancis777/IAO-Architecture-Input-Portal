S/4HANA 2023 Finance & Controlling Cutover

Architecture Review Document — Material Ledger Focus

Migration from ICOST → ECC → S/4HANA 2023

Version 1.1 | Refined with Material Ledger Cutover Sequencing



Executive Summary

This document consolidates architecture decisions, data flows, configuration dependencies, and cutover sequencing for a migration from an ICOST-based costing engine (feeding GL postings to SAP ECC) to SAP S/4HANA 2023 with:



Account-Based CO-PA / Margin Analysis (Universal Journal — ACDOCA)

Material Ledger with actual costing (mandatory in S/4HANA)

COGS Split to cost components

SAC for planning (writing to ACDOCP)

Mid-year cutover assumed (most complex scenario)


The primary refinement in this version is the Material Ledger cutover cycle — upload timing, per-plant/per-site sequencing, material extension requirements, and the initialization sequence that must precede any transactional go-live.



1. Architecture Overview

flowchart TD
    classDef source fill:#fff3e0,stroke:#e65100,color:#000
    classDef integration fill:#e8f5e9,stroke:#2e7d32,color:#000
    classDef target fill:#e3f2fd,stroke:#1565c0,color:#000
    classDef reporting fill:#f3e5f5,stroke:#6a1b9a,color:#000

    class ICOST,ECC_FI,ECC_CO,ECC_PP source
    class CUTOVER_LAYER,LTMC,LSMW,FB01,SAC_CONN,ML_STARTUP integration
    class ACDOCA,ACDOCP,ML_TABLES,CE4 target
    class FIORI_MA,CKM3N,COPA_RPT reporting

    ICOST["ICOST<br>Costing Engine<br>External cost calculation<br>Feeds GL postings to ECC"]
    ECC_FI["SAP ECC<br>FI Module<br>GL Balances<br>AP/AR/Assets/Stock"]
    ECC_CO["SAP ECC<br>CO Module<br>Cost Center Actuals<br>Production Order WIP"]
    ECC_PP["SAP ECC<br>PP Module<br>Open Production Orders<br>WIP / BOM / Routings"]

    CUTOVER_LAYER["Cutover Layer<br>Data Extraction + Validation<br>Balance Reconciliation<br>Sequence Control"]
    LTMC["LTMC<br>Migration Cockpit<br>Template-based loads<br>GL / CC / Stock / Assets"]
    LSMW["LSMW<br>Legacy Migration<br>Workbench<br>Batch IDoc loads"]
    FB01["FB01 / F-65<br>Manual FI Postings<br>Opening entries<br>WIP balances"]
    SAC_CONN["SAC Connector<br>Direct writeback<br>Plan data → ACDOCP"]
    ML_STARTUP["CKMSTART<br>ML Startup Program<br>Per-plant initialization<br>Translates PO histories"]

    ACDOCA["ACDOCA<br>Universal Journal — Actuals<br>Single source of truth<br>FI + CO + ML + MA"]
    ACDOCP["ACDOCP<br>Universal Journal — Plan<br>Cost center plans<br>GL account plans"]
    ML_TABLES["Material Ledger<br>CKMLHD / CKMLPR<br>CKMLCR / CKMLPP<br>MLDOC / MLDOCCCS"]
    CE4["CE4xxxx<br>Profitability Segments<br>Margin Analysis<br>Characteristics"]

    FIORI_MA["Fiori: Market Segments<br>Plan vs Actual<br>Contribution Margin"]
    CKM3N["CKM3N<br>Material Price Analysis<br>ML Validation"]
    COPA_RPT["CO-PA Reports<br>Segment Reporting<br>Cost Component Drill"]

    ICOST -->|"Legacy GL postings<br>to ECC"| ECC_FI
    ECC_FI -->|"Extract balances<br>for cutover"| CUTOVER_LAYER
    ECC_CO -->|"Extract CC actuals<br>WIP balances"| CUTOVER_LAYER
    ECC_PP -->|"Extract open orders<br>BOM / Routings"| CUTOVER_LAYER

    CUTOVER_LAYER --> LTMC
    CUTOVER_LAYER --> LSMW
    CUTOVER_LAYER --> FB01
    CUTOVER_LAYER --> ML_STARTUP

    LTMC --> ACDOCA
    LSMW --> ACDOCA
    FB01 --> ACDOCA
    SAC_CONN --> ACDOCP
    ML_STARTUP --> ML_TABLES

    ACDOCA --> ML_TABLES
    ACDOCA --> CE4
    ML_TABLES --> ACDOCA
    CE4 --> FIORI_MA
    ACDOCA --> FIORI_MA
    ACDOCA --> CKM3N
    ACDOCP --> FIORI_MA
    ACDOCA --> COPA_RPT



2. Material Ledger: What Changes from ECC to S/4HANA 2023

This is not optional. In S/4HANA, Material Ledger is mandatory for all plants. The data model has been significantly restructured.


ECC Table	S/4HANA Replacement	Purpose
MLHD, MLIT, MLPP, MLPPF, MLCR, MLCRF, CKMLPP, CKMLCR	MLDOC and MLDOC_EXTRACT	ML transactional data + settlement
MLKEPH, CKMLKEPH	MLDOCCCS and MLDOCCCS_EXTRACT	Cost component split in actual costing
CKMLMV011	MLRUNLIST	Material/activity type status from costing run
MBEW, EBEW, OBEW, QBEW	ACDOCA (Universal Journal)	Inventory valuation

(Material Ledger in SAP S4HANA Functionality and Configuration.pdf — product-costing)


Key S/4HANA 2023 simplification relevant to cutover planning: the four separate closing steps — Single-Level Price Determination, Multilevel Price Determination, Revaluation of Consumption, WIP Revaluation — are merged into one step called Settlement in S/4HANA. Plan your cutover runbook around the new single-step model, not the ECC four-step model. (SIMPL_OP2022.pdf — product-costing)



3. Material Ledger Cutover: The Core Cycle

3.1 The Fundamental Constraint

The ML startup program (CKMSTART) is the gate. No goods movements, no new material masters, and no production order transactions are permitted between ML activation in Customizing (OMX1) and the completion of CKMSTART. This window must be protected absolutely during the cutover weekend.


(Actual Costing with the SAP Material Ledger — product-costing)


3.2 What CKMSTART Does Per Plant

When run, CKMSTART:



Creates ML master data (CKMLHD, CKMLPR) for all existing materials in the plant

Translates all material prices and stock values into the ML currencies defined in OMX2/OMX3

Translates existing PO histories into the second and third ML currencies

Initializes cost component split data for existing inventory — sourced from the standard cost estimate; if no cost component split exists on the standard cost, the total is summarized into the material consumption component


(Actual Costing with the SAP Material Ledger — product-costing)


3.3 Upload Cycle: Timing and Sequence

The ML upload cycle is period-boundary-driven. SAP's strong recommendation is to activate at the beginning of a period because ML begins updating the actual quantity structure from the moment of activation — any transactions before CKMSTART completion that are not captured will create gaps in the multilevel costing quantity structure.


flowchart TD
    classDef source fill:#fff3e0,stroke:#e65100,color:#000
    classDef integration fill:#e8f5e9,stroke:#2e7d32,color:#000
    classDef target fill:#e3f2fd,stroke:#1565c0,color:#000
    classDef reporting fill:#f3e5f5,stroke:#6a1b9a,color:#000

    class PRE_REQS source
    class OMX1_ACT,CKMSTART_RUN,STD_COST,MAT_EXT,STOCK_LOAD integration
    class ML_LIVE,CKM3N_VAL,CKMLCP_READY target
    class SIGN_OFF reporting

    PRE_REQS["Pre-Requisites Complete<br>OMX2/OMX3 configured<br>ML Type assigned to valuation area<br>All prior costing runs closed<br>No open CKMLCP / CKMLCPAVR"]

    OMX1_ACT["OMX1<br>Activate ML in Customizing<br>Per valuation area / plant<br>⚠️ Goods movements now locked"]

    STD_COST["CK11N / CK40N<br>Create + Release<br>Standard Cost Estimates<br>For go-live period<br>Must exist BEFORE CKMSTART"]

    MAT_EXT["Extend Materials to ML<br>Material Master MRP/Costing views<br>Price control = S<br>Price determination = 3<br>Per plant scope"]

    CKMSTART_RUN["CKMSTART<br>ML Startup Program<br>Run per plant batch<br>Translates stock values + PO history<br>Initializes cost component split"]

    STOCK_LOAD["LTMC / MB1C<br>Upload Initial Stock Balances<br>Movement type 561<br>At standard cost<br>After CKMSTART — not before"]

    ML_LIVE["ML Active + Initialized<br>Goods movements re-enabled<br>ML documents begin posting<br>Actual quantity structure building"]

    CKM3N_VAL["CKM3N<br>Material Price Analysis<br>Validate: opening stock value<br>= FI balance sheet balance"]

    CKMLCP_READY["CKMLCP Ready<br>Actual Costing Run<br>Available at period end<br>Settlement replaces 4-step close"]

    SIGN_OFF["Finance Sign-Off<br>ML balance = GL balance<br>Per plant, per material type<br>Before go-live declaration"]

    PRE_REQS --> OMX1_ACT
    OMX1_ACT --> STD_COST
    STD_COST --> MAT_EXT
    MAT_EXT --> CKMSTART_RUN
    CKMSTART_RUN --> STOCK_LOAD
    STOCK_LOAD --> ML_LIVE
    ML_LIVE --> CKM3N_VAL
    CKM3N_VAL --> SIGN_OFF
    SIGN_OFF --> CKMLCP_READY



4. Material Extension: Per-Plant Requirements

Every material that will be valued in ML must have the correct master data configuration before CKMSTART runs. Missing or misconfigured materials at startup will not be initialized and will require remediation post-go-live, which is complex.


4.1 Material Master Settings Required

View	Field	Required Value	Notes
Costing 1	Price control	S (Standard)	ML actual costing uses standard as base — MAP materials not selected in actual costing run
Costing 1	Price determination	3	Enables actual costing; 2 = no ML actual costing
Costing 1	Costing lot size	Populated	Must match standard cost estimate
MRP 2	Plant-specific material status	Active	No restrictions that block goods movements
Accounting 1	Moving price	Populated	Starting price for initialization
Accounting 1	Standard price	Populated from CK11N release	Must be released before CKMSTART


⚠️ Critical: Materials with price determination 2 and price control S (standard price without ML actual costing) are not selected in the actual costing run (CKMLCP). If ICOST previously valued materials using MAP logic, a deliberate decision is required on whether to migrate them to price determination 3 before go-live. Changing price determination from 3 to 2 post-go-live (via CKMM) causes all ML documents for that material to be excluded from closing — a significant audit risk. (SAP-Material-LedgerOBYC.pdf — product-costing)



4.2 Per-Plant Extension Sequence

flowchart LR
    classDef source fill:#fff3e0,stroke:#e65100,color:#000
    classDef integration fill:#e8f5e9,stroke:#2e7d32,color:#000
    classDef target fill:#e3f2fd,stroke:#1565c0,color:#000

    class MAT_LIST source
    class MM01_EXT,CK11N_EST,CK11N_REL,CKMM_CHECK integration
    class MAT_READY target

    MAT_LIST["Material Scope<br>Per plant / valuation area<br>Extract from ECC<br>Identify price control gaps"]

    MM01_EXT["MM01 / MM50<br>Extend to plant<br>Set Price Control = S<br>Set Price Det = 3<br>Costing views populated"]

    CK11N_EST["CK11N<br>Create Standard Cost Estimate<br>Per material per plant<br>Costing variant for go-live period"]

    CK11N_REL["CK11N / CK24<br>Release Standard Cost<br>Updates Accounting 1<br>Standard price field<br>Must be done before CKMSTART"]

    CKMM_CHECK["CKMM<br>Verify Price Determination<br>= 3 for all actuals materials<br>Spot-check before startup"]

    MAT_READY["Material Ready<br>for CKMSTART<br>All views populated<br>Standard cost released<br>Price det = 3"]

    MAT_LIST --> MM01_EXT
    MM01_EXT --> CK11N_EST
    CK11N_EST --> CK11N_REL
    CK11N_REL --> CKMM_CHECK
    CKMM_CHECK --> MAT_READY


4.3 Pre-Requisite Checks Before CKMSTART (Per Plant)

Check	Transaction	Pass Condition
All prior ML costing runs complete	CKMLCP	No runs in status 'open' or partial
No incomplete CKMLCPAVR runs	CKMLCPAVR	All alternative valuation runs closed
Standard cost estimates released for go-live period	CK24	All relevant materials have released standard
Price determination = 3 for actuals-scope materials	CKMM / SE16 T001W.MGVUPD	Field = X per plant
ML Type assigned to valuation area	OMX3	All plants in same company code → same ML type
ML currency types explicitly defined	OMX2	No default type "0000" — must be explicit in S/4HANA
PO history data archived / cleaned	EKBE, EKBZ	Reduce CKMSTART runtime
Manufacturing orders closed	CO02	All orders settled before startup

2. ICOST Migration Context
 
What ICOST Does vs. What S/4HANA Replaces It With
 
Capability	ICOST + ECC	S/4HANA 2023 Native
Cost calculation engine	External ICOST engine	CO-PC — standard cost estimates (CK11N)
GL posting generation	ICOST → ECC via interface	SAP accounting interface — real-time to ACDOCA
Cost component split	ICOST-defined components	Cost component structure in CO-PC
Material valuation	MAP or standard in ECC	Material Ledger mandatory — actual costing
Variance calculation	ICOST-driven	KKS1/KKS2 — standard variance categories
Period-end costing run	ICOST batch	CKMLCP — actual costing run
Plan costing	ICOST plan model	SAC → ACDOCP + CK40N plan cost estimates
 
    ⚠️ Critical design decision: ICOST cost components must be mapped to SAP cost component structure before cutover. Any mismatch between ICOST cost categories and SAP cost components will cause COGS split errors from day one. This mapping should be completed and validated in the Explore phase. (Product Cost Controlling with SAP.pdf — product-costing)
 

3. Scenario Matrix
 
Three Cutover Scenarios to Consider
 
Scenario	Description	Complexity	Recommended?
A — Year-End Cutover	Go-live on first day of new fiscal year	Low	Yes — if timeline allows
B — Mid-Year Cutover	Go-live during fiscal year	High	Only if business-mandated
C — Mid-Period Cutover	Go-live mid-period (not period end)	Very High	Avoid — closing risk extreme
 
This document designs for Scenario B (Mid-Year) as the base case — it subsumes Scenario A and covers Scenario C with additional controls.
 

4. WIP Balances — The Critical Design Decision
 
This is the most complex element of your cutover given open production orders mid-flight. There are three design options:
 

WIP Option 1: Settle All WIP Before Cutover (Recommended)
 
Thesis: Force all open production orders to a settleable state in ECC before go-live. Zero WIP at cutover.
 
flowchart LR
    classDef source fill:#fff3e0,stroke:#e65100,color:#000
    classDef integration fill:#e8f5e9,stroke:#2e7d32,color:#000
    classDef target fill:#e3f2fd,stroke:#1565c0,color:#000

    class OPEN_ORDERS source
    class TECO_STEP,SETTLE_STEP,REVERSE_STEP integration
    class CLEAN_STATE target

    OPEN_ORDERS["ECC Open<br>Production Orders<br>Partial completions<br>WIP balances"]
    TECO_STEP["TECO — Technically Complete<br>All open orders flagged<br>Locks further goods issues<br>Allows settlement"]
    SETTLE_STEP["KO88 / CO88<br>Settle WIP to<br>Price Difference account<br>or P&L"]
    REVERSE_STEP["Re-open in S/4HANA<br>New production orders<br>created post go-live<br>Fresh start"]
    CLEAN_STATE["Zero WIP Balance<br>at Cutover<br>Clean balance sheet<br>No stranded costs"]

    OPEN_ORDERS --> TECO_STEP
    TECO_STEP --> SETTLE_STEP
    SETTLE_STEP --> CLEAN_STATE
    CLEAN_STATE --> REVERSE_STEP

 
Pros:
 
    • Cleanest cutover — no WIP complexity in S/4HANA opening
    • FI = CO reconciliation is straightforward
    • No special cutover BOM/routing required
 
Cons:
 
    • Operationally disruptive — production must pause before go-live
    • Settlement of partially complete orders distorts period P&L
    • May not be feasible for long-cycle manufacturing
 

WIP Option 2: Load WIP as Balance Sheet Opening Entry (Pragmatic)
 
Thesis: Load WIP balances to the balance sheet via FB01, create shell production orders in S/4HANA, and continue operations post go-live.
 
flowchart TD
    classDef source fill:#fff3e0,stroke:#e65100,color:#000
    classDef integration fill:#e8f5e9,stroke:#2e7d32,color:#000
    classDef target fill:#e3f2fd,stroke:#1565c0,color:#000
    classDef reporting fill:#f3e5f5,stroke:#6a1b9a,color:#000

    class ECC_WIP,ECC_ORDERS source
    class WIP_EXTRACT,BOM_CREATE,ROUTING_CREATE,ORDER_CREATE,GOODS_ISSUE integration
    class BS_WIP,S4_ORDERS,ACDOCA_WIP target
    class WIP_RPT reporting

    ECC_WIP["ECC WIP Balances<br>Per production order<br>Material + Labor +<br>Overhead components"]
    ECC_ORDERS["ECC Open Orders<br>Order number / material<br>Qty completed / remaining<br>Components issued"]

    WIP_EXTRACT["Extract WIP<br>by Cost Component<br>Map ICOST categories<br>to SAP components"]
    BOM_CREATE["Create Cutover BOM<br>in S/4HANA<br>Remaining components only<br>Already-issued excluded"]
    ROUTING_CREATE["Create Cutover Routing<br>Remaining operations only<br>Confirmed operations<br>excluded"]
    ORDER_CREATE["CO01 — Create<br>S/4HANA Production Order<br>Reference cutover BOM<br>+ Routing"]
    GOODS_ISSUE["MB1A / MIGO<br>Issue WIP materials<br>to new S/4 order<br>at standard cost"]

    BS_WIP["FB01 — WIP Balance<br>Sheet Entry<br>Dr: WIP Account<br>Cr: Clearing Account"]
    S4_ORDERS["S/4HANA<br>Production Orders<br>Carry forward<br>remaining work"]
    ACDOCA_WIP["ACDOCA<br>WIP postings with<br>cost component split<br>+ profitability segment"]
    WIP_RPT["WIP Report<br>KKAX / KKAO<br>Validate WIP balance<br>= BS entry"]

    ECC_WIP --> WIP_EXTRACT
    ECC_ORDERS --> BOM_CREATE
    ECC_ORDERS --> ROUTING_CREATE

    WIP_EXTRACT --> BS_WIP
    BOM_CREATE --> ORDER_CREATE
    ROUTING_CREATE --> ORDER_CREATE
    ORDER_CREATE --> GOODS_ISSUE

    BS_WIP --> ACDOCA_WIP
    GOODS_ISSUE --> S4_ORDERS
    S4_ORDERS --> ACDOCA_WIP
    ACDOCA_WIP --> WIP_RPT


 
Cutover BOM / Routing Design:
 
Element	ECC Source	S/4HANA Cutover Design
BOM	Full production BOM	Remaining BOM — exclude already-issued components
Routing	Full routing with all operations	Remaining routing — confirmed operations marked done
Production Order	Open ECC order with WIP	New S/4 order referencing cutover BOM + routing
WIP Balance	Per ICOST cost components	FB01 BS entry Dr WIP / Cr Cutover Clearing
Goods Issue	Already issued in ECC	Issue remaining components only post go-live
Confirmation	Partially confirmed	Confirm remaining operations as executed
 
WIP GL Account Mapping:
 
Dr/Cr	G/L Account	Description	Amount Basis
Dr	13100000	WIP — Raw Material Component	ICOST material cost
Dr	13200000	WIP — Labor	ICOST labor cost
Dr	13300000	WIP — Fixed Overhead	ICOST fixed OH
Dr	13400000	WIP — Variable Overhead	ICOST variable OH
Cr	19999999	Cutover Clearing Account	Total WIP balance
 
    The clearing account is reversed post go-live once the production order in S/4HANA absorbs the costs through normal goods issue and confirmation postings. (SAP Activate methodology for S4HANA cFIN.xlsx — product-costing)
 

WIP Option 3: Direct Transfer via Migration Cockpit (Complex)
 
Thesis: Use LTMC to migrate open production orders directly with their WIP balances intact.
 
Aspect	Detail
LTMC Object	Production Order with components and operations
WIP handling	WIP balance migrated as order actual costs
ML impact	ML must be initialized before order migration
Risk	High — order status management complex across systems
Recommended?	Only for simple, short-cycle manufacturing
 
Verdict: Option 2 (Balance Sheet entry + Cutover BOM/Routing) is the most pragmatic and auditable approach for complex manufacturing with ICOST legacy costs.
 

5. Master Sequence: Cutover Steps in Order
 
Pre-Cutover (Weeks Before Go-Live)
 
Step	Action	Owner	Transaction	Dependency
P1	Map ICOST cost components to SAP cost component structure	Costing team	OKTZ	None — must be first
P2	Activate Material Ledger per plant	BASIS/FI	OMX1 / SPRO	After ML config
P3	Configure COGS split accounts	FI	SPRO — OBYC	After GL master setup
P4	Configure OKB9 default account assignments	CO	OKB9	After GL + CC master
P5	Configure CO-PA characteristic derivation	CO-PA	KEA5 / KEA6	After segment design
P6	Configure assessment cycles	CO	KSU1	After CC hierarchy
P7	Create and validate cutover BOMs	PP	CS01	After BOM design
P8	Create and validate cutover routings	PP	CA01	After routing design
P9	Extract WIP balances from ECC by cost component	Finance	SE16 / COEP	After ICOST mapping
P10	Freeze ECC production orders	PP	CO02 — TECO partial	Before cutover weekend
 

Cutover Weekend — Day 1: Foundation
 
Step	Action	Transaction	Validates Against
D1-1	Lock ECC users	SU01 mass lock	All ECC access stopped
D1-2	Run ECC final period close	MMPV + F.16	ECC balance sheet final
D1-3	Extract final ECC trial balance	F.	
