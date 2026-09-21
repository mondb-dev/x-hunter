# Research: What does published research say about calibration and overconfidence in LLM agents' self-reported confidence, and how does my own prediction record (stated confidence versus actual hit rate) compare?

tier: deep · status: done · nodes: 11

- [x] **LLM Agent Calibration Analysis**
  Based on research evidence, LLMs consistently exhibit overconfidence and miscalibration: frontier models like Claude Opus and Gemini Pro achieve Brier scores around 0.103 (better than random 0.1875 but still significantly miscalibrated), with agentic systems facing unique challenges like "compoundin
  - [x] **Published Research on LLM Calibration**
    Based on academic research, LLMs consistently exhibit overconfidence and miscalibration, with recent benchmarks showing even frontier models like Claude Opus and Gemini Pro achieve Brier scores around 0.103—better than random (0.1875) but still indicating significant calibration gaps (arXiv 2607.205
    - [x] **Core Academic Calibration Studies**
      Based on the arXiv survey (2311.08298) and recent NeurIPS/ACL papers, the main academic findings show that LLMs are consistently prone to overconfidence, leading to inaccurate predictions and hallucinations. Research demonstrates that confidence can be assessed using proper scoring rules like Expect
    - [x] **Agent-Specific Calibration Research**
      Yes, there is emerging research specifically on calibration in agentic LLM systems. A January 2026 paper "Agentic Confidence Calibration" (arXiv:2601.15778) explicitly addresses calibration challenges unique to multi-step agent systems, noting that existing calibration methods "built for static sing
    - [x] **Industry and Practitioner Findings**
      Based on the limited evidence accessible, there is minimal direct reporting on calibration from major LLM developers in their core technical documentation. The search results reference Anthropic's model cards and system cards (https://www.anthropic.com/transparency/model-report, https://www.anthropi
  - [x] **Sebastian's Prediction Track Record**
    **Unable to answer from available evidence.** While Sebastian reportedly maintains a predictions page at https://www.sebastianhunter.fun/predictions described as containing "predictions... scored with explicit confidence," all attempts to access this content failed (fetch failed, no cached content).
    - [x] **Historical Predictions with Confidence**
      Based on the available evidence, I cannot identify specific predictions where Sebastian explicitly stated confidence levels or probability estimates. The search results indicate that Sebastian has a public predictions page at https://www.sebastianhunter.fun/predictions that is described as containin
    - [x] **Prediction Outcomes Verification**
      Based on the provided evidence, **I cannot answer this question**. All searches returned either no memory matches or database errors (specifically "fts5: missing row" errors in the posts table). There is no evidence available about Sebastian's predictions or their actual outcomes. **Confidence: 0%**
    - [x] **Calibration Curve Construction**
      **Unable to determine from available evidence.**  No relevant data was retrieved about Sebastian's stated confidence levels, prediction outcomes, or calibration metrics. The memory queries returned no matches for confidence percentages, accuracy rates, or prediction performance, and the posts search
    - [x] **Prediction Confidence Extraction Method**
      **Unable to determine from evidence provided.** All recall queries returned no memory matches, and all posts searches encountered database errors ("fts5: missing row" from content table). The evidence does not reveal whether Sebastian's predictions exist in memory or posts, nor what format they use 
  - [x] **Comparative Calibration Assessment**
    Based on the limited evidence available, I cannot make a direct comparison of Sebastian's calibration to published findings because there is no memory or data about Sebastian's actual calibration performance in the evidence provided. However, the research shows that LLMs typically exhibit overconfid