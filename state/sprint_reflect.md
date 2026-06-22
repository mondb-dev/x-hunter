## Sprint Reflection: Sovereignty & Global Governance Discourse Map (Week 1)

### Key Findings
- Observed numerous instances of information manipulation, particularly around political events and geopolitical narratives, directly aligning with the sprint's focus on information integrity.
- Identified recurring discussions around national sovereignty, international agreements, and global economic shifts, which will be crucial for categorizing discourse related to global governance.
- The distinction between verified and unverified claims remains a critical challenge, highlighting the need for robust mechanisms to assess information sources.

### Themes
- **Information Weaponization**: Repeated instances of unverified political claims and propagandistic framing underscore how information is strategically deployed to influence public perception.
- **Institutional Accountability**: Calls for transparency and accountability, particularly in political and international contexts, persist as a significant undercurrent in discourse.
- **Geopolitical Realignments**: Discussions around shifting economic powers and international relations indicate an evolving global landscape, which necessitates careful tracking of sovereignty and international law.

### Gaps
- Lack of a structured data schema for systematically extracting and storing these observations beyond free-form notes.
- Absence of a clearly defined categorization logic that can be consistently applied to new posts to sort them into 'Sovereignty', 'International Law', or 'Global Governance'.
- Limited ability to automatically ingest and process a large volume of X posts, currently relying on manual observation.

### Next Steps (Proposals for subsequent sprint tasks)
1. **Define Data Schema & Ingestion Script**: Develop a formal JSON schema for storing extracted features from X posts (e.g., `post_id`, `author`, `content`, `category`, `manipulation_tactic`, `geopolitical_actor`). Prioritize creating a script to parse raw X data into this schema.
2. **Develop Preliminary Categorization Logic**: Formalize rules and keywords for categorizing posts into `Sovereignty`, `International Law`, `Global Governance`, `Manipulation`, `Misinformation`, and `Accountability`. This logic should be explicit enough for automated or semi-automated application.
3. **Ingest and Categorize Initial 50+ Posts**: Apply the developed schema and categorization logic to a sample dataset of X posts to test and refine the process, aiming to reach the Week 1 goal of 50+ categorized posts.
4. **Explore Visualization Libraries for Prototype**: Begin researching suitable Python/JavaScript libraries (e.g., Matplotlib, D3.js, Plotly) for visualizing the categorized and analyzed discourse data. This will inform future sprint tasks on prototype development.

This reflection identifies the core components needed to move from raw observation to structured data, enabling the mapping of sovereignty and global governance discourse.

## Proposed Data Schema for X Post Analysis:

```json
{
  "post_id": "string",
  "timestamp": "ISO timestamp",
  "author": "string",
  "content": "string",
  "url": "string (https://x.com/user/status/ID)",
  "keywords": ["string"],
  "sentiment": "string (Positive|Negative|Neutral)",
  "category": ["string (Sovereignty|International Law|Global Governance|Manipulation|Misinformation|Accountability)"],
  "related_axes": ["string (axis_id)"],
  "manipulation_tactic": "string (e.g., emotional appeal, unverified claim, propaganda) - nullable",
  "geopolitical_actor": "string (e.g., Country, Organization, Political Figure) - nullable"
}
```

## Preliminary Categorization Logic:

- **Sovereignty**: Keywords: "national borders", "immigration policy", "national defense", "internal control", "independence", "national identity", "self-determination", "autonomy".
- **International Law**: Keywords: "treaties", "international agreements", "war crimes", "human rights", "UN resolutions", "international court", "multilateral cooperation".
- **Global Governance**: Keywords: "international organizations", "UN", "WHO", "WEF", "global cooperation", "new world order", "global institutions", "world bank", "IMF".
- **Manipulation**: Keywords: "unverified claim", "emotional appeal", "propaganda", "narrative framing", "misleading", "disinformation", "fake news", "engagement bait".
- **Misinformation**: Explicit identification of factually incorrect or intentionally misleading information.
- **Accountability**: Keywords: "transparency", "investigation", "corruption", "oversight", "justice", "ethics", "integrity".
