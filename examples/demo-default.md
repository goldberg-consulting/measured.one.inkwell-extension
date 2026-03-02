---
title: "Value Mining Accelerator Platform Architecture Specification"
author: "Ember Analytics"
date: "February 2026"
abstract: |
  This document responds to technical review comments on the Value Mining
  Accelerator platform architecture, addressing questions on LLM
  orchestration, Clean Room security, machine learning validation, and
  the downstream analysis workflow. Full architectural details are
  maintained in the platform specification (v3.1, February 2026).

# --- Document class and page layout ---
# documentclass: article             # default: article
fontsize: 11pt                        # 10pt, 11pt, 12pt
# classoption:                        # passed to \documentclass
#   - twocolumn
#   - landscape
geometry: "margin=1in"                # any geometry package string
linestretch: 1.4                      # line spacing multiplier

# --- Fonts (XeLaTeX) ---
# mainfont: "Palatino"               # system font name
# mainfontoptions:
#   - BoldFont=Palatino Bold
# sansfont: "Helvetica"
# sansfontoptions: []
# monofont: "Fira Code"
# monofontoptions:
#   - Scale=0.85

# --- Hyperlink colors ---
# linkcolor: RoyalBlue               # internal links (default: RoyalBlue)
# citecolor: OliveGreen              # citation links (default: OliveGreen)
# urlcolor: RoyalBlue                # URL links (default: RoyalBlue)

# --- Front matter sections ---
# toc: true                           # table of contents
# lof: true                           # list of figures
# lot: true                           # list of tables

# --- Bibliography ---
# bibliography: references/refs.bib
# link-citations: true

# --- Cross-reference prefixes (pandoc-crossref) ---
figPrefix: "Figure"
tblPrefix: "Table"
eqnPrefix: "Equation"
secPrefix: "Section"

# --- Custom LaTeX in the preamble ---
# header-includes: |
#   \usepackage{tikz}
#   \definecolor{accent}{HTML}{2E86AB}

# --- Inkwell styling ---
inkwell:
  code-bg: "#f5f5f5"                  # background color for code blocks
  code-border: true                   # border around code blocks
  code-rounded: true                  # rounded corners on code blocks
  code-font-size: small               # tiny, scriptsize, footnotesize, small, normalsize
  code-display: output                # default display: output, both, code, none
  tables: booktabs                    # booktabs, grid, plain
  table-font-size: small              # tiny, scriptsize, footnotesize, small, normalsize
  table-stripe: false                 # alternating row shading
  hanging-indent: false               # hanging indent for bibliography
  caption-style: above                # above or below figures/tables
  # columns: 2                        # force two-column layout
  python-env: ./venv                  # Python virtual environment path
---

# Overview {#sec:overview}

**This document responds** to technical review comments submitted by Yacine Lahkim Bennani on February 20, 2026, regarding the Value Mining Accelerator platform architecture. The responses address questions on LLM orchestration, Clean Room security, machine learning validation, and the downstream analysis workflow. Full architectural details are maintained in the Value Mining Accelerator Platform Architecture specification (v3.1, February 2026).

# MCP Server Approach {#sec:mcp}

**We are proposing** to build a custom MCP server that runs as a Databricks App in each party's workspace, not inside the Clean Room. The Clean Room produces derived output tables (gold-layer, standardized Tuva schema) and Delta Shares them back to each party's Unity Catalog metastore. The MCP server sits downstream of that share, querying the materialized output tables via Databricks SQL.

> Each party deploys the same wheel as a Databricks App in their own workspace. PwC runs it against PwC's copy of the derived outputs; the client deploys the same wheel against the client's copy. PwC does not operate infrastructure that touches client data at query time.

The MCP server would expose a fixed set of pre-approved tools to LLMs: query curated output tables, retrieve schemas, and execute report templates, with eventual integration into Copilot, Teams, Word, and other productivity surfaces. All queries would be parameterized with typed inputs. The LLM would never receive a direct SQL connection or access to raw data.

The following describes the intended interaction model. We are verifying the implementation details with Databricks.

1. A user asks a natural-language question to an LLM (e.g., "What are the top cost drivers for the CHF cohort by service category?").
2. The LLM translates the question into an MCP tool call. It does not write SQL. It selects from a fixed menu of pre-approved tools (e.g., `query_analytics`, `get_schema`, `run_report`) and fills in the tool's typed parameters (e.g., `cohort="CHF"`, `metric="allowed_amount"`, `group_by="service_category"`). A later phase may allow the LLM to generate constrained SQL directly; the initial implementation restricts it to parameterized tool calls.
3. The MCP server receives the tool call. The server is a Python application (packaged as a wheel) running as a Databricks App in the workspace. It validates the parameters against the tool's schema, constructs a parameterized SQL query, and executes it against the gold-layer output tables in that workspace's Unity Catalog.
4. The MCP server applies output guardrails to the query result before returning it. PHI scanning checks whether any result field contains identifiable information. Cell suppression removes any aggregate row with fewer than 11 members. Complementary suppression removes additional cells to prevent back-calculation.
5. The MCP server returns the filtered result to the LLM. The LLM receives a structured result set, not a database connection. It can only see what the tool returned after guardrails.
6. The LLM summarizes the result in natural language and presents it to the user.

> **Why parameterized tools matter for NIS.** No freeform SQL means no prompt injection path to raw data and a deterministic audit trail for every interaction. Each query is reproducible from its parameters. The LLM receives only structured result sets after output guardrails. This satisfies NIS requirements for access control (enumerated per layer), audit (every query logged and reproducible), and data minimization (the LLM never sees more than the tool returns).

@fig:data-flow illustrates the data sharing architecture. The de-identification wheel runs inside the Clean Room, producing PHI-free and member-level tables. PHI-free tables are Delta Shared to both PwC's and the client's Unity Catalog metastores; member-level tables are Delta Shared only to the client. Each party's MCP server runs downstream against its own materialized copy.

```{mermaid caption="Clean Room data sharing architecture" label="data-flow"}
flowchart LR
    subgraph cleanRoom ["Clean Room"]
        DeID[De-id Wheel]
        PHIFree[PHI-Free Tables]
        MemberLevel[Member-Level Tables]
    end

    subgraph pwc ["PwC Metastore"]
        PwCTables[PHI-Free Tables Only]
        PwCMCP[PwC MCP Server]
    end

    subgraph client ["Client Metastore"]
        ClientPHIFree[PHI-Free Tables]
        ClientMember[Member-Level Tables]
        ClientMCP[Client MCP Server]
    end

    DeID --> PHIFree
    DeID --> MemberLevel
    PHIFree -->|"Delta Share"| PwCTables
    PHIFree -->|"Delta Share"| ClientPHIFree
    MemberLevel -->|"Delta Share"| ClientMember
    PwCTables --> PwCMCP
    ClientPHIFree --> ClientMCP
    ClientMember --> ClientMCP
```


# Ember MCP Analytics Architecture: Two Phases {#sec:phases}

## Phase 1: Constrained Tool Calls (LLM as Parameter Extractor) {#sec:phase1}

| Layer | What Happens |
|---|---|
| **User** | Asks a natural-language question (e.g., "Top cost drivers for CHF cohort by service category?") |
| **Outer LLM** | Selects from a fixed menu of pre-approved MCP tools. Fills typed parameters (`cohort`, `metric`, `group_by`). Does **not** write SQL. |
| **MCP Server** | Python wheel running as a Databricks App. Validates parameters against tool schema. Constructs parameterized SQL. Executes against gold-layer Unity Catalog tables. |
| **Guardrails** | PHI scan on output fields. Cell suppression ($n < 11$). Complementary suppression to prevent back-calculation. All deterministic, all auditable. |
| **Response** | Filtered result set returned to LLM. LLM summarizes in natural language for the user. |

## Phase 2: Agent-as-a-Tool (Genie / Autonomous Agent) {#sec:phase2}

| Layer | What Happens |
|---|---|
| **User** | Same natural-language question. |
| **Outer LLM** | Recognizes an analytics question and delegates the full prompt to a single MCP tool (`ask_analytics_agent`). Does not decompose the question itself. |
| **Inner Agent** | A reasoning system (Databricks Genie, LangGraph, etc.) running inside the secure workspace perimeter. Has access to Unity Catalog metadata, business glossary, trusted SQL assets. Writes its own SQL, executes queries, may run follow-up queries autonomously. |
| **Guardrails** | Layered: (1) Unity Catalog row/column security limits what the agent can see. (2) Trusted SQL and query validation constrain generated queries. (3) Output guardrails (PHI scan, cell suppression) applied by MCP server before return. (4) Optional AI Gateway input/output filters on the agent's own LLM calls. |
| **Response** | Agent returns structured result to MCP server, output guardrails are applied, outer LLM narrates to user. |

## Comparison {#sec:comparison}

| Dimension | Phase 1: Constrained Tools | Phase 2: Agent-as-a-Tool |
|---|---|---|
| **Query flexibility** | Limited to pre-built tool menu. New question types require new tools. | Can answer novel, unanticipated questions. |
| **SQL generation** | None. Parameterized templates only. | Inner agent writes freeform SQL grounded by trusted assets. |
| **Auditability** | Perfect: every query is deterministic from parameters. | Requires logging full agent chain-of-thought and generated SQL. |
| **PHI risk surface** | Minimal. Known queries against known tables. | Larger. Inner agent's LLM sees raw results before output guardrails. Mitigated by UC permissions and pre-aggregated gold tables. |
| **Hallucination risk** | Low: LLM can only fill parameters, not invent queries. | Real: agent may write incorrect SQL or misinterpret columns. Trusted assets mitigate but do not eliminate. |
| **Build effort** | Higher per-tool. Each question type is hand-built. | Lower for breadth: point agent at gold tables and it covers a wide surface immediately. |
| **Compliance posture** | Easy to defend to a regulator. | Defensible with sufficient logging and perimeter controls, but more infrastructure required. |
| **Best for** | High-frequency, high-stakes queries (the 20 questions that cover 80% of needs). | Exploratory and ad-hoc analysis for power users with appropriate permissions. |

## Recommended Approach {#sec:recommended}

**Phase 1 is the production default.** Ship the constrained tool menu for the core analytics workflows: cohort costs, utilization, risk scores, campaign ROI. Every query is auditable, deterministic, and PHI-safe by construction.

**Phase 2 is the power-user mode.** Gate behind permissions and logging. The outer LLM routes between phases: if the question matches a known tool signature, Phase 1 handles it; if the question is novel, the outer LLM delegates to the agent with disclosure that the response is AI-generated exploratory analysis.

> **Phase 2 and NIS.** The autonomous agent operates within the same perimeter (East US, ephemeral compute, encrypted, no data retention), but NIS will scrutinize the larger surface: the inner agent's LLM processes query results before output guardrails are applied. An ARR submission for Phase 2 must document the layered mitigations explicitly: Unity Catalog row/column security, pre-aggregated gold tables, AI Gateway filters, and full chain-of-thought logging. Phase 1 needs none of this because it is deterministic by construction.

# LLM Architecture {#sec:llm}

**Q1.** *To confirm my understanding: the LLM acts as an interface and orchestration layer that translates user prompts into governed MCP tool calls executed inside the Clean Room, and then summarizes approved outputs. Correct?*

Yes. The LLM functions as an orchestration layer that translates natural-language prompts into governed MCP tool calls. Those tool calls execute against curated, pre-approved datasets; the LLM then summarizes the approved outputs and returns them to the user. The LLM does not access raw data directly. All queries pass through MCP-defined tools with authentication, authorization, PHI detection guardrails, and immutable audit logging at every step.

> **NIS security posture.** The Clean Room is owned and managed by Databricks, not by PwC or the client. All compute is serverless: provisioned on demand, executed, and destroyed. Data is encrypted at rest (cloud provider KMS) and in transit (TLS). The AI model interacts with data transitionally only: no caching, no memory, no context persistence between sessions. Data does not leave the designated cloud region (East US).

The Clean Room never stores source data; it reads client data via Delta Sharing and produces only derived products. All interim derived products (intermediate DataFrames, temporary tables, aggregation buffers) exist only in ephemeral serverless compute and are destroyed with it. Final derived products are delivered to the client; PwC does not retain copies. Client data is not used to train or fine-tune LLMs. MCP output guardrails validate responses before they are returned to users, scanning for PHI elements and enforcing aggregation minimums.

At present, the immediate goal is code sharing: validated Python wheels are deployed to ephemeral serverless compute within an ephemeral Clean Room environment. The Clean Room itself is a Delta Sharing construct, not a persistent workspace, and is destroyed after the engagement.

PwC maintains its own internal MCP governance infrastructure. A GitHub Enterprise Cloud MCP Registry currently catalogs MCP servers (GitHub and Atlassian servers are active for testing). A PwC MCP Marketplace is planned to replace this limited registry, providing formal registration, access control, and audit processes for all MCP servers. The Value Mining Accelerator MCP server will be registered through this marketplace and subject to the same centralized governance.

Full architectural details are documented in the Value Mining Accelerator Platform Architecture specification.

**Q2.** *From a contractual and governance perspective, is the LLM compute considered part of the client's Clean Room environment, or part of PwC's managed infrastructure?*

The Clean Room environment is owned and managed by Databricks, not by the client or PwC. Databricks operates the serverless control plane, manages the ephemeral compute lifecycle, and enforces the isolation guarantees. PwC deploys validated code (as wheel packages) into the Clean Room. Client data enters via Delta Sharing. Neither PwC nor the client provisions or administers the Clean Room infrastructure directly.

> **Three-party access model.** Because Databricks owns the infrastructure, neither PwC nor the client can escalate privileges within the Clean Room. Compute lifecycle is managed by Databricks' serverless control plane. Every notebook execution requires mutual approval. All access is logged to `system.access.clean_room_events`. This satisfies NIS access control and compute isolation requirements without either party needing to trust the other's internal controls.

**Q3.** *To confirm, the LLM performs retrieval exclusively through MCP-controlled tools and does not directly access raw datasets. Correct?*

There are two contexts in which LLMs interact with data, and the access model differs between them.

During internal analytics development, LLMs are used against PwC's own internal and licensed datasets (CMS data, Purple Labs, reference data). These interactions are mediated through the PwC Databricks workspace, where standard Unity Catalog access controls, audit logging, and governance policies apply. No client PHI is present in this environment.

> The MCP server does not run inside the Clean Room. The only sanctioned data egress path from the Clean Room is output tables, which are Delta Shared back to each party's Unity Catalog metastore. The MCP server runs downstream, on top of these materialized output tables.

For client-facing retrieval, our proposal is that PwC develops a validated MCP server and delivers it as a wheel package through the standard code promotion pipeline. Databricks natively supports hosting custom MCP servers as Databricks Apps. Each party deploys the wheel as a Databricks App in their own workspace, where it is accessible at a workspace-scoped URL with authentication handled through the workspace's own OAuth and service principals. Because the output tables follow a standardized data model, the same MCP server code works on both sides: PwC runs it against PwC's copy of the derived outputs, and the client deploys the same wheel in the client's workspace against the client's copy. PwC does not operate infrastructure that touches client data at query time.

The MCP server exposes a fixed set of pre-approved tools (query curated output tables, retrieve schemas, execute report templates), each with parameterized queries, typed schemas, and output guardrails (PHI scanning, aggregation minimums). The LLM can only invoke these tools and receives only the tool output, never a direct connection to the underlying data. Runtime security (service principal scoping, Unity Catalog ACLs, audit logging) is enforced by the operating party's own Databricks environment.

**Q4.** *When probabilistic embeddings are applied to client data, are they fully computed inside the Clean Room under the same PHI protections?*

Yes. Probabilistic embeddings are fully computed inside the Clean Room on ephemeral serverless compute, under the same PHI protections as all other Clean Room operations. The embedding models are trained within PwC's internal environment using internal and licensed data (no client PHI), then deployed as validated wheel packages through the standard promotion pipeline. At execution time, the models run inference against client data read via Delta Sharing, produce derived products (member-level embedding vectors, risk scores, cohort assignments), and those derived products are delivered to the client. All interim artifacts, including the embedding vectors themselves and any intermediate representations, exist only in ephemeral serverless compute and are destroyed when the compute is destroyed. PwC does not retain copies of client-derived embeddings.

> **Training/inference separation.** Models are trained exclusively on PwC's internal and licensed data (no client PHI touches the training process). Client data enters only at inference time, on ephemeral serverless compute, inside the Clean Room. Outputs are derived products (embedding vectors, risk scores, cohort assignments), not copies of input data. When compute is destroyed, all intermediate representations are destroyed with it. Client data is not used to train, fine-tune, or update any model weights. This satisfies both the NIS "no caching, no persistence" requirement and the AI Policy prohibition on training with client data.

# Machine Learning Validation {#sec:ml}

**Q5.** *To confirm: the ML models are developed and validated internally using licensed data, then deployed into the Clean Room where they process client data to generate predictions, risk scores, and cohort outputs. Correct?*

*Response pending.*

**Q6.** *What statistical validation approach is used (e.g., holdout datasets, cross-validation) to ensure models generalize well before deployment?*

*Response pending.*

**Q7.** *What performance metrics are used to evaluate model quality, and what thresholds determine deployment readiness?*

The metrics depend on the model type and the clinical task. There is no single threshold; deployment readiness is evaluated against task-specific criteria established during the validation phase.

> **AI Policy: quality and accuracy.** Section 4.1 of the PwC US AI Policy requires "steps as appropriate or applicable to promote the quality and accuracy of AI Systems and Technologies, and inputs to and outputs therefrom." The "as appropriate" qualifier permits task-specific validation frameworks rather than universal thresholds. The validation approach here, with per-model-type metrics, clinical interpretation of error costs, and deployment readiness tied to actuarial and clinical context, satisfies this requirement proportionally.

**Classification models** (e.g., cohort assignment, risk tier prediction):

- Precision, recall, F1 score (per class and macro-averaged)
- AUROC and AUPRC for probabilistic classifiers
- Sorensen-Dice coefficient for set-overlap tasks (e.g., comparing predicted vs. actual diagnosis sets, episode membership, or cohort overlap between model-assigned and clinically validated groups)
- Confusion matrices with clinical interpretation of false positive / false negative costs

**Reconstruction and representation models** (e.g., autoencoders, VAEs on claims data):

- Reconstruction quality: binary cross-entropy or mean squared error between input and reconstructed claims images
- Sorensen-Dice coefficient for binary reconstruction fidelity (measuring overlap between original and reconstructed binary claims matrices)
- Cluster separation: silhouette score, Davies-Bouldin index, Calinski-Harabasz index on latent representations
- Cluster clinical coherence: whether latent clusters correspond to clinically meaningful groups (evaluated by subject matter review)

**Regression models** (e.g., cost prediction, utilization forecasting):

- MAE, RMSE, MAPE on held-out test sets
- $R^2$ and adjusted $R^2$
- Residual analysis for systematic bias (e.g., underprediction for high-cost members)

**Temporal and time-series models** (e.g., disease progression, stage transitions):

- Time-series classification accuracy and F1 at each prediction horizon
- Concordance index (C-statistic) for survival and progression models
- Calibration plots comparing predicted vs. observed event rates

Thresholds are not fixed globally. They are established per use case during the validation phase based on the clinical and actuarial context: the cost of false positives vs. false negatives, the baseline prevalence, and the intended use of the model output (screening vs. intervention targeting vs. reporting).

## Example: VAE Reconstruction Metrics {#sec:vae-example}

> The convolutional VAE compresses each member's 48-week $\times$ 100-ICD binary claims image into a 32-dimensional latent representation. Precision and recall are computed at the cell level, treating each week-ICD cell as an independent binary prediction. The Sorensen-Dice coefficient is the harmonic mean of precision and recall.

The following results are from a convolutional VAE trained on 20,000 members' claims histories, where each member is represented as a $48 \times 100$ binary image (48 weeks $\times$ 100 ICD codes).

| Metric | Value |
|---|---|
| Final loss (total) | 135.1 |
| Reconstruction loss | 96.1 |
| KL divergence | 130.1 |
| KL per dimension (mean) | 4.07 nats |
| Active dimensions (KL $> 0.5$) | 32/32 |
| PCA variance (2D projection) | 35.7% |
| Avg precision (raw) | 0.7115 |
| Avg recall (raw) | 0.9999 |
| Avg Dice (raw) | 0.8314 |
| Avg cosine similarity (raw) | 0.8491 |
| Avg precision (postprocessed) | 0.7941 |
| Avg recall (postprocessed) | 0.9752 |
| Avg Dice (postprocessed) | 0.8754 |
| Parameters | 11,174,144 |
| Epochs | 1,000 |
| Members evaluated | 20,000 |

**Interpreting the precision/recall pattern.** Recall approaching 1.0 means the decoder recovers every diagnosis code that appeared in the member's history. No clinical signal is lost during compression from 4,800 binary values to 32 latent dimensions. Precision below 1.0 means the decoder activates cells beyond those in the original image. These are not random noise: they are codes the model considers probable given the member's pattern. A member with E11 (type 2 diabetes) and I10 (hypertension) may have E78 (hyperlipidemia) activated in the reconstruction even if absent from the observed claims, because the model has learned that these codes co-occur with high frequency in the population.

This is the expected behavior of a well-regularized generative model. The latent space encodes a clinical archetype, not a verbatim copy. The gap between precision and recall quantifies how much the model has generalized beyond the individual member's data.

**Postprocessing to improve precision.** Three sequential filters are applied to the raw decoder output before binarization, without modifying model weights or training:

1. *Clinical exclusion mask*: passthrough (demographic columns not yet available).
2. *Empirical co-occurrence gate*: a conditional probability matrix $P(j|i)$ computed from the training population removes codes that never co-occur with the member's actual diagnoses (threshold $p \geq 0.005$).
3. *Adaptive per-member top-k*: per-member binarization retaining at most $1.3\times$ the true active cell count, preventing high-utilization archetypes from over-predicting on low-utilization members.

Result: precision $0.711 \to 0.794$ (+11.6%), recall $1.000 \to 0.975$, Dice $0.831 \to 0.875$.

**Q8.** *Can you provide a high-level overview of the types of licensed datasets used to train the models (e.g., claims, pharmacy, public CMS data) to understand their coverage and representativeness?*

*Response pending.*

**Q9.** *How is model performance monitored post-deployment, and what triggers retraining or updates?*

*Response pending.*

# Downstream Analysis Workflow {#sec:downstream}

**The question is always:** does the output contain PHI?

> From our last engagements, 99% of deliverables could have been produced without PHI. Population-level outputs (PMPM trends, cohort distributions, scorecards, staging stock-and-flow) are aggregated by design and could flow to our metastore for normal downstream work.

*"There's a point I'm still not clear on: we discussed it a bit twice but didn't finish, about the actual workflow of how we'll execute analysis when the clean room is set up. E.g., if we need to use Excel, create PowerPoints off it, etc."*

**If no:** it flows back to our catalog and we work with it normally (SQL, Excel, PowerPoint, BI tools).

**If yes:** we either (a) de-identify or aggregate inside the Clean Room before it exits, or (b) access the client's Databricks via VDI. Option (b) is not recommended for routine work. Any analysis we might do in Excel on member-level data can be done inside the Clean Room, though compute there is ephemeral (deploy code, serverless execution, view results, destroyed).

For the remaining cases, the pipeline includes an explicit de-identification step inside the Clean Room: drop direct identifiers, replace member IDs with random surrogates, generalize dates to age bands, truncate ZIPs, suppress small cells. The goal is to reduce the data to a level comparable to our existing Purple Labs dataset: clinically useful, analytically complete, but free of individually identifiable information. The output is a PHI-free table safe to share back.

Because this de-identification step runs inside the Clean Room, the rules and their application are visible to the client and subject to their sign-off. The client approves what exits the Clean Room. The de-id configuration (which columns are dropped, how dates are generalized, what suppression thresholds apply) is defined per engagement, reviewed by both parties, and executed as auditable code. Nothing leaves the Clean Room without the client's approval of the egress rules.

> **NIS egress control.** The de-identification configuration is auditable code, not a manual process. Both parties review and approve the rules before execution. Unity Catalog audit logs record every table written and every Delta Share created. Data residency is preserved throughout: the Clean Room, the output tables, and the Delta Shares all reside in East US. Encryption at rest and in transit applies to the shared outputs. This satisfies NIS requirements for audit trail, access control, data residency, and encryption at the data egress boundary.
