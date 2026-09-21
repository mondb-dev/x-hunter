# Research: What do METR's measurements of the length of tasks AI agents can complete autonomously show about the trend, and what are the strongest critiques of extrapolating it?

tier: deep · status: done · nodes: 10

- [x] **METR autonomous agent task completion trends and extrapolation critiques**
  METR's measurements show the "50%-task-completion time horizon" for AI agents has been **doubling approximately every 7 months since 2019**, reaching ~50 minutes by early 2025 for frontier models like Claude 3.7 Sonnet (https://metr.org/blog/2025-03-19-measuring-ai-ability-to-complete-long-tasks/). 
  - [x] **METR task length measurements and trend**
    According to METR's measurements, the "50%-task-completion time horizon" (the duration of tasks that AI models can complete with 50% success rate) has been **doubling approximately every 7 months since 2019**, with potential acceleration in 2024. By early 2025, frontier models like Claude 3.7 Sonnet
    - [x] **METR organization and evaluation framework**
      Based on the available evidence, **METR (Model Evaluation and Threat Research)** is an organization that evaluates autonomous AI capabilities and publishes evaluation reports on models like GPT-5.1-Codex-Max and Claude 3.7 Sonnet. They use an evaluation framework detailed in their "Example autonomy 
      - [x] **METR's public reports and blog posts**
        METR maintains a dedicated resources page at https://metr.org/measuring-autonomous-ai-capabilities/ that collects their evaluation reports, task suites, and best practices for measuring autonomous AI capabilities. Their published work includes evaluation reports on models like GPT-5.1-Codex-Max, GPT
    - [x] **Historical METR measurements across models**
      According to METR's research, they measured the "50%-task-completion time horizon" - the duration of tasks (measured by human expert completion time) that AI models can complete with 50% success rate. For Claude 3.7 Sonnet and similar frontier models as of early 2025, this was approximately 50 minut
  - [x] **Strongest critiques of extrapolating METR trends**
    Based on the evidence, the most substantive critiques of extrapolating METR's autonomous task length trends forward are: **(1) Sparse statistical foundation** - METR's horizon length plot for critical 2025 projections (1-4 hours) relies on only 14 samples, raising concerns about statistical robustne
    - [x] **Methodological critiques of METR evaluations**
      Based on the evidence provided, key methodological limitations of METR's evaluation approach include: **Sparse data density and statistical robustness**: A critique from lessw-blog (via pseedr.com) notes that METR's horizon length plot for critical 2025 projections (1-4 hours of work) relies on only
    - [x] **Scaling and capability ceiling arguments**
      Based on the evidence, several arguments suggest autonomous task length improvements may not continue to scale: **Fundamental planning limits**: Research on long-horizon planning (arxiv.org/html/2601.22311) identifies "fundamental limits of reasoning-based policy in long-horizon planning" and docume
    - [x] **Task complexity vs duration distinction critiques**
      Based on the evidence, I cannot find any critiques that specifically focus on the distinction between task length/duration versus task complexity/difficulty in the context of AI agent capability extrapolation. The METR blog post (https://metr.org/blog/2025-03-19-measuring-ai-ability-to-complete-long
    - [x] **Academic and expert critiques of agent evaluations**
      Researchers have identified several critical limitations of current autonomous agent evaluations, particularly regarding their applicability to real-world deployment. The OpenAgentSafety framework authors note that "most [prior benchmarks] fall short by relying on simulated environments, narrow task