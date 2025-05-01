export const postPromptConfig = {
  prompt: `Below are the responses from all models in the previous iteration. Consider these responses when making your evaluation.  Try to reflect on the responses and gain insight into the scenario:

Previous Responses:
{{previousResponses}}

Please provide your updated evaluation based on both the original scenario and these previous responses.`
};
