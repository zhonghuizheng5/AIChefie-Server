import { createServer } from "node:http";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Bonjour } from "bonjour-service";
import {
  buildNoteCompatibilityPrompt,
  buildImagePrompt,
  buildRecipePrompt,
  cleanString,
  combineImageReviews,
  extractImageDataURL,
  generateValidatedImage,
  ingredientConfidenceThreshold,
  normalizeImageReview,
  normalizeConfirmedIngredientDetails,
  normalizeIngredientScene,
  normalizeNoteCompatibility,
  normalizeRecipeAudit,
  normalizeStringArray,
  openRouterUsageCost,
  sameName,
  structuredRecipeViolations,
} from "./strict-ingredients.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv(join(__dirname, ".env"));

const primaryImageModel =
  process.env.OPENROUTER_PRIMARY_IMAGE_MODEL
  || process.env.OPENROUTER_IMAGE_MODEL
  || "bytedance-seed/seedream-4.5";

const config = {
  port: Number(process.env.PORT || 8787),
  apiKey: process.env.OPENROUTER_API_KEY,
  analysisModel: process.env.OPENROUTER_ANALYSIS_MODEL || "google/gemini-3.1-pro-preview",
  recipeModel: process.env.OPENROUTER_RECIPE_MODEL || "google/gemini-3.1-flash-lite",
  reviewModel:
    process.env.OPENROUTER_REVIEW_MODEL
    || process.env.OPENROUTER_ANALYSIS_MODEL
    || "google/gemini-3.1-pro-preview",
  secondOpinionModel:
    process.env.OPENROUTER_SECOND_OPINION_MODEL
    || "openai/gpt-5.4-mini",
  primaryImageModel,
  fallbackImageModel:
    process.env.OPENROUTER_FALLBACK_IMAGE_MODEL
    || primaryImageModel,
};

const bonjour = new Bonjour();
const requestContext = new AsyncLocalStorage();
let bonjourService;

const server = createServer((request, response) => {
  const requestID =
    cleanString(request.headers["x-request-id"])
    || randomUUID();
  response.setHeader("X-Request-ID", requestID);

  requestContext.run({ requestID }, () => {
    handleRequest(request, response).catch((error) => {
      console.error("CookLens request handler failed unexpectedly", {
        requestID,
        message: error.message || String(error),
      });
      if (!response.headersSent) {
        sendJSON(response, 500, { error: "Unexpected server error" });
      } else {
        response.end();
      }
    });
  });
});

async function handleRequest(request, response) {
  const startedAt = Date.now();
  const requestID = currentRequestID();

  try {
    console.log(`${new Date().toISOString()} ${request.method} ${request.url}`, {
      requestID,
    });

    if (request.method === "GET" && request.url === "/health") {
      sendJSON(response, 200, {
        ok: true,
        configured: Boolean(config.apiKey),
        analysisModel: config.analysisModel,
        recipeModel: config.recipeModel,
        reviewModel: config.reviewModel,
        secondOpinionModel: config.secondOpinionModel,
        imageModel: config.primaryImageModel,
        primaryImageModel: config.primaryImageModel,
        fallbackImageModel: config.fallbackImageModel,
        simulatorURL: `http://127.0.0.1:${config.port}`,
        phoneURLs: localNetworkURLs(),
      });
      return;
    }

    if (request.method !== "POST") {
      sendJSON(response, 404, { error: "Not found" });
      return;
    }

    if (!config.apiKey) {
      sendJSON(response, 500, {
        error: "Missing OPENROUTER_API_KEY in CookLensServer/.env",
      });
      return;
    }

    const body = await readJSONBody(request);

    if (request.url === "/api/analyze") {
      sendJSON(response, 200, await analyzeIngredients(body));
      return;
    }

    if (request.url === "/api/recipes") {
      sendJSON(response, 200, await generateRecipes(body));
      return;
    }

    if (request.url === "/api/dish-image") {
      sendJSON(response, 200, await generateDishImage(body));
      return;
    }

    if (request.url === "/api/generate") {
      const recipeResult = await generateRecipes(body);
      const recipes = await Promise.all(
        recipeResult.recipes.map(async (recipe) => {
          try {
            const image = await generateDishImage({
              dishName: recipe.dishName,
              detectedIngredients: recipe.detectedIngredients,
              confirmedIngredientDetails: recipe.confirmedIngredientDetails,
              pantrySeasoningsUsed: recipe.pantrySeasoningsUsed,
              steps: recipe.steps,
              finalPresentation: recipe.finalPresentation,
            });
            return {
              ...recipe,
              imageDataURL: image.imageDataURL,
              imageError: image.imageError,
              imageVerified: Boolean(image.imageDataURL),
            };
          } catch (error) {
            return {
              ...recipe,
              imageDataURL: null,
              imageError: error.message,
              imageVerified: false,
            };
          }
        })
      );

      sendJSON(response, 200, {
        recipes,
        source: {
          analysisModel: config.analysisModel,
          recipeModel: config.recipeModel,
          reviewModel: config.reviewModel,
          secondOpinionModel: config.secondOpinionModel,
          imageModel: config.primaryImageModel,
          primaryImageModel: config.primaryImageModel,
          fallbackImageModel: config.fallbackImageModel,
        },
      });
      return;
    }

    sendJSON(response, 404, { error: "Not found" });
  } catch (error) {
    console.error(`${new Date().toISOString()} ${request.method} ${request.url} failed`, {
      requestID,
      durationMs: Date.now() - startedAt,
      message: error.message || String(error),
      code: error.code || null,
    });
    sendJSON(response, error.statusCode || 500, {
      error: error.message || "Unexpected server error",
      ...(error.code ? { code: error.code } : {}),
      ...(error.details ? error.details : {}),
    });
  }
}

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${config.port} is already in use. Stop the old CookLens server or use a different PORT.`);
  } else {
    console.error(error);
  }
  process.exit(1);
});

server.listen(config.port, () => {
  const phoneURLs = localNetworkURLs();

  bonjourService = bonjour.publish({
    name: "CookLens AI Server",
    type: "cooklens",
    protocol: "tcp",
    port: config.port,
    txt: {
      version: "2",
      path: "/api/generate",
      urls: phoneURLs.join(","),
    },
  });

  console.log(`CookLens server listening for simulator: http://127.0.0.1:${config.port}`);
  for (const url of phoneURLs) {
    console.log(`CookLens server listening for real iPhone: ${url}`);
  }
  console.log(`CookLens Bonjour service published as _cooklens._tcp.local with URLs: ${phoneURLs.join(", ")}`);
});

process.on("unhandledRejection", (error) => {
  console.error("Unhandled rejection:", error);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
  process.exit(1);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    bonjourService?.stop(() => {
      bonjour.destroy();
      server.close(() => process.exit(0));
    });
  });
}

function localNetworkURLs() {
  const interfaces = networkInterfaces();
  const urls = [];

  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) {
        urls.push(`http://${entry.address}:${config.port}`);
      }
    }
  }

  return urls;
}

function loadEnv(filePath) {
  try {
    const contents = readFileSync(filePath, "utf8");
    for (const line of contents.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const separator = trimmed.indexOf("=");
      if (separator === -1) continue;
      const key = trimmed.slice(0, separator).trim();
      const value = trimmed.slice(separator + 1).trim();
      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch {
    // .env is optional so the server can still report a clear setup error.
  }
}

async function readJSONBody(request) {
  const chunks = [];
  let size = 0;
  const maxSize = 12 * 1024 * 1024;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxSize) {
      throw httpError(413, "Request body is too large");
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw httpError(400, "Request body must be valid JSON");
  }
}

function sendJSON(response, statusCode, payload) {
  const requestID = currentRequestID();
  response.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  response.end(JSON.stringify({
    ...payload,
    ...(requestID ? { requestID } : {}),
  }));
}

function currentRequestID() {
  return requestContext.getStore()?.requestID || null;
}

function httpError(statusCode, message, code, details) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  error.details = details;
  return error;
}

async function generateRecipes(input) {
  const suppliedIngredientDetails =
    Array.isArray(input.confirmedIngredientDetails)
    && input.confirmedIngredientDetails.length > 0;
  const confirmedIngredientDetails = normalizeConfirmedIngredientDetails(
    input.confirmedIngredientDetails,
    input.approvedPhotoIngredients
  );
  const approvedPhotoIngredients = confirmedIngredientDetails.length
    ? confirmedIngredientDetails.map((ingredient) => ingredient.name)
    : normalizeStringArray(input.approvedPhotoIngredients);
  const pantrySeasonings = normalizeStringArray(input.pantrySeasonings);
  const notes = typeof input.notes === "string" ? input.notes.trim() : "";

  if (approvedPhotoIngredients.length === 0) {
    throw httpError(400, "approvedPhotoIngredients must contain at least one confirmed photo ingredient");
  }

  const unknownStateIngredients = confirmedIngredientDetails
    .filter((ingredient) => ingredient.state === "unknown")
    .map((ingredient) => ingredient.name);
  if (suppliedIngredientDetails && unknownStateIngredients.length) {
    throw httpError(
      409,
      `Choose whether these ingredients are raw or cooked: ${unknownStateIngredients.join(", ")}`,
      "ingredient_state_required"
    );
  }

  console.log("CookLens generation input", {
    approvedPhotoIngredients,
    confirmedIngredientDetails,
    pantrySeasonings,
    notes,
  });

  if (notes) {
    const noteCompatibility = await checkNoteCompatibility(
      approvedPhotoIngredients,
      pantrySeasonings,
      notes
    );

    console.log("CookLens notes compatibility", noteCompatibility);
    if (!noteCompatibility.compatible) {
      throw httpError(
        409,
        noteCompatibility.reason
          || "Your notes request food that is not present in the confirmed ingredients.",
        "note_conflict",
        {
          conflict: {
            confirmedIngredients: approvedPhotoIngredients,
            requestedStyle: noteCompatibility.requestedStyle,
            unsupportedIngredients: noteCompatibility.unsupportedIngredients,
            reason: noteCompatibility.reason,
          },
        }
      );
    }
  }

  let recipes = await requestRecipeOptions({
    approvedPhotoIngredients,
    confirmedIngredientDetails,
    pantrySeasonings,
    notes,
  });
  let validation = await validateRecipeSet(
    recipes,
    approvedPhotoIngredients,
    pantrySeasonings,
    confirmedIngredientDetails
  );

  for (let repairAttempt = 1; !validation.valid && repairAttempt <= 2; repairAttempt += 1) {
    console.warn(`CookLens recipe validation failed; repair attempt ${repairAttempt}`, {
      reason: validation.reason,
      violations: validation.violations || validation.unapprovedIngredients,
      recipes: recipeLogSummary(recipes),
    });
    recipes = await requestRecipeOptions({
      approvedPhotoIngredients,
      confirmedIngredientDetails,
      pantrySeasonings,
      notes,
      previousRecipes: recipes,
      repairFeedback: validation.reason,
    });
    validation = await validateRecipeSet(
      recipes,
      approvedPhotoIngredients,
      pantrySeasonings,
      confirmedIngredientDetails
    );
  }

  if (!validation.valid) {
    const violations = validation.violations || validation.unapprovedIngredients || [];
    const detail = violations
      .map((violation) => {
        if (typeof violation === "string") return violation;
        return `Option ${violation.optionIndex ?? "?"}: ${violation.ingredient} in "${violation.evidence}"`;
      })
      .join("; ");
    throw httpError(
      422,
      `CookLens could not safely repair the recipes. ${detail || validation.reason}`,
      "recipe_validation_failed",
      { violations }
    );
  }

  recipes = recipes.map((recipe) => ({
    ...recipe,
    detectedIngredients: approvedPhotoIngredients,
    confirmedIngredientDetails,
    pantrySeasoningsUsed: recipe.pantrySeasoningsUsed.filter((seasoning) =>
      pantrySeasonings.some((approved) => sameName(approved, seasoning))
    ),
  }));

  return {
    recipes,
    source: {
      analysisModel: config.analysisModel,
      recipeModel: config.recipeModel,
      reviewModel: config.reviewModel,
      secondOpinionModel: config.secondOpinionModel,
    },
  };
}

async function checkNoteCompatibility(approvedPhotoIngredients, pantrySeasonings, notes) {
  const parsed = await callOpenRouterStructured({
    stage: "notes review",
    model: config.reviewModel,
    messages: [
      {
        role: "system",
        content:
          "You interpret cooking requests against a closed ingredient whitelist. Distinguish cooking styles from concrete ingredients and return valid JSON.",
      },
      {
        role: "user",
        content: buildNoteCompatibilityPrompt({
          approvedPhotoIngredients,
          pantrySeasonings,
          notes,
        }),
      },
    ],
    response_format: { type: "json_object" },
    temperature: 0,
    max_tokens: 500,
  });

  return normalizeNoteCompatibility(parsed);
}

async function analyzeIngredients(input) {
  const imageBase64 = requiredString(input.imageBase64, "imageBase64");
  const imageMimeType = input.imageMimeType || "image/jpeg";
  const prompt = [
    "Inspect this photo and classify the scene before identifying ingredients.",
    "",
    "Scene types:",
    "- prepared_ingredient: raw or ready-to-cook grocery food, butchered meat, seafood, vegetables, fruit, pantry food, or packaged food.",
    "- cooked_food: already cooked or prepared food that could be reused as an ingredient.",
    "- live_animal: any living animal, bird, fish, pet, or wildlife. Do not treat a live animal as a cooking ingredient.",
    "- non_food: no edible cooking ingredient is visible.",
    "- unclear: photo is too blurry, cropped, dark, or ambiguous to classify.",
    "",
    "Identify only edible ingredients that are visibly present when the scene type is prepared_ingredient or cooked_food.",
    "Do not infer sides, seasonings, sauces, garnish, or ingredients that would normally be served with the visible item.",
    "Raw food should be named as precisely as the image supports, without inventing preparation details.",
    "A live animal should set sceneType to live_animal and detectedIngredients to an empty array.",
    "Return a confidence from 0 to 1 for every ingredient.",
    "For every ingredient, report state as raw, cooked, or unknown; form such as whole, fillet, sliced, or chopped; and an approximate visible quantity.",
    `Set requiresConfirmation to true when any important ingredient is below ${ingredientConfidenceThreshold} confidence, any state is unknown, the primary ingredient is ambiguous, or the image may not depict food ingredients.`,
    "Return compact JSON only.",
    "",
`{
  "sceneType": "prepared_ingredient | cooked_food | live_animal | non_food | unclear",
  "sceneConfidence": 0.0,
  "sceneReason": "short explanation",
  "detectedIngredients": [
    {
      "name": "string",
      "confidence": 0.0,
      "state": "raw | cooked | unknown",
      "form": "short description or null",
      "quantity": "short estimate or null"
    }
  ],
  "requiresConfirmation": true,
  "uncertaintyReason": "short explanation or null"
}`,
  ].join("\n");

  const parsed = await callOpenRouterStructured({
    stage: "ingredient analysis",
    model: config.analysisModel,
    messages: [
      {
        role: "system",
        content:
          "You are a conservative visual ingredient detector. Report only food visibly present in the photo and return valid JSON.",
      },
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          {
            type: "image_url",
            image_url: {
              url: `data:${imageMimeType};base64,${imageBase64}`,
            },
          },
        ],
      },
    ],
    response_format: { type: "json_object" },
    temperature: 0,
    max_tokens: 700,
  });

  const detectedIngredients = normalizeDetectedIngredients(parsed.detectedIngredients);
  const scene = normalizeIngredientScene(parsed, detectedIngredients);
  if (scene.sceneType === "live_animal") {
    throw httpError(
      422,
      "This appears to be a live animal rather than a prepared cooking ingredient.",
      "live_animal_detected",
      { scene }
    );
  }
  if (scene.sceneType === "non_food") {
    throw httpError(
      422,
      "CookLens could not identify a visible cooking ingredient in this photo.",
      "no_food_detected",
      { scene }
    );
  }
  if (scene.sceneType === "unclear" && detectedIngredients.length === 0) {
    throw httpError(
      422,
      "CookLens could not clearly identify the ingredient. Try a sharper, closer photo.",
      "photo_unclear",
      { scene }
    );
  }
  if (detectedIngredients.length === 0) {
    throw httpError(
      422,
      "CookLens could not identify a visible cooking ingredient in this photo.",
      "no_food_detected",
      { scene }
    );
  }

  const lowConfidence = detectedIngredients.some(
    (ingredient) => ingredient.confidence < ingredientConfidenceThreshold
  );
  const unknownState = detectedIngredients.some(
    (ingredient) => ingredient.state === "unknown"
  );
  const weakSceneClassification = scene.sceneConfidence < ingredientConfidenceThreshold;

  console.log("CookLens ingredient analysis", {
    ...scene,
    detectedIngredients,
    requiresConfirmation:
      Boolean(parsed.requiresConfirmation)
      || lowConfidence
      || unknownState
      || scene.sceneType === "unclear"
      || weakSceneClassification,
  });

  return {
    ...scene,
    detectedIngredients,
    requiresConfirmation:
      Boolean(parsed.requiresConfirmation)
      || lowConfidence
      || unknownState
      || scene.sceneType === "unclear"
      || weakSceneClassification,
    uncertaintyReason:
      cleanString(parsed.uncertaintyReason)
      || (lowConfidence || unknownState || scene.sceneType === "unclear" || weakSceneClassification
        ? "Confirm the ingredient and whether it is raw or already cooked."
        : null),
  };
}

async function requestRecipeOptions({
  approvedPhotoIngredients,
  confirmedIngredientDetails,
  pantrySeasonings,
  notes,
  previousRecipes,
  repairFeedback,
}) {
  const parsed = await callOpenRouterStructured({
    stage: "recipe generation",
    model: config.recipeModel,
    messages: [
      {
        role: "system",
        content:
          "You are CookLens, a strict practical cooking assistant. The supplied ingredient whitelist is absolute. Return valid compact JSON only.",
      },
      {
        role: "user",
        content: buildRecipePrompt({
          approvedPhotoIngredients,
          confirmedIngredientDetails,
          pantrySeasonings,
          notes,
          previousRecipes,
          repairFeedback,
        }),
      },
    ],
    response_format: { type: "json_object" },
    temperature: previousRecipes ? 0 : 0.25,
    max_tokens: 1800,
  });

  return normalizeRecipeResponse(
    parsed,
    pantrySeasonings,
    notes
  );
}

async function validateRecipeSet(
  recipes,
  approvedPhotoIngredients,
  pantrySeasonings,
  confirmedIngredientDetails
) {
  const structuredViolations = structuredRecipeViolations(
    recipes,
    approvedPhotoIngredients,
    pantrySeasonings,
    confirmedIngredientDetails
  );
  if (structuredViolations.length) {
    return {
      valid: false,
      reason: structuredViolations.join("; "),
      unapprovedIngredients: structuredViolations,
      violations: structuredViolations,
    };
  }

  const prompt = [
    "Audit these recipes against the closed ingredient whitelist.",
    `Allowed photo ingredients: ${approvedPhotoIngredients.join(", ")}`,
    `Confirmed ingredient details: ${JSON.stringify(confirmedIngredientDetails)}`,
    `Allowed pantry seasonings: ${pantrySeasonings.length ? pantrySeasonings.join(", ") : "none"}`,
    "",
    "Inspect dish names, ingredient arrays, and every instruction.",
    "Inspect finalPresentation as part of the recipe.",
    "Water and heat are allowed utilities.",
    "Soup liquid, glaze, broth, or sauce made only from water and approved pantry seasonings is allowed and is not an extra ingredient.",
    "Do not infer hidden ingredients from color, shine, texture, or the name of an approved seasoning.",
    "Raw ingredients must be cooked appropriately. Cooked ingredients must not be treated as raw or given raw-to-done instructions.",
    "The recipe must preserve confirmed forms and quantities instead of silently changing to another cut, whole animal, or extra pieces.",
    "The separate pairingSuggestion may mention another food, but that food must not appear anywhere else.",
    "Cooking-style and dish-format words are not ingredients. Do not reject salad, soup, bowl, roasted, grilled, stir-fry, braised, glazed, spicy, crispy, or similar words unless the recipe actually introduces a concrete unapproved food.",
    "For an extra-food violation, name the concrete unapproved ingredient and quote the exact recipe text.",
    "For a raw/cooked or form mismatch, use ingredient = 'food state' or 'ingredient form' and quote the exact conflicting recipe text.",
    "Do not report generic violations such as 'unapproved food'. If there is no concrete ingredient or state/form mismatch with exact evidence, return an empty violations array.",
    `Recipes: ${JSON.stringify(recipes)}`,
    "",
    `Return JSON only:
{
  "violations": [
    {
      "optionIndex": 1,
      "ingredient": "specific unapproved food",
      "evidence": "exact recipe phrase"
    }
  ],
  "reason": "short explanation"
}`,
  ].join("\n");

  const parsed = await callOpenRouterStructured({
    stage: "recipe review",
    model: config.reviewModel,
    messages: [
      {
        role: "system",
        content:
          "You are a precise recipe compliance auditor. Enforce concrete ingredient limits without mistaking cooking styles for ingredients.",
      },
      { role: "user", content: prompt },
    ],
    response_format: { type: "json_object" },
    temperature: 0,
    max_tokens: 600,
  });
  return normalizeRecipeAudit(parsed);
}

function recipeLogSummary(recipes) {
  return recipes.map((recipe, index) => ({
    optionIndex: index + 1,
    dishName: recipe.dishName,
    detectedIngredients: recipe.detectedIngredients,
    pantrySeasoningsUsed: recipe.pantrySeasoningsUsed,
    steps: recipe.steps,
  }));
}

async function generateDishImage(input) {
  const dishName = requiredString(input.dishName, "dishName");
  const detectedIngredients = normalizeStringArray(input.detectedIngredients);
  const confirmedIngredientDetails = normalizeConfirmedIngredientDetails(
    input.confirmedIngredientDetails,
    detectedIngredients
  );
  const pantrySeasoningsUsed = normalizeStringArray(input.pantrySeasoningsUsed);
  const steps = normalizeStringArray(input.steps);
  const finalPresentation = cleanString(input.finalPresentation) || null;
  if (detectedIngredients.length === 0) {
    throw httpError(400, "detectedIngredients must contain the confirmed photo ingredients");
  }

  const recipe = { dishName, steps };
  const result = await generateValidatedImage({
    maxAttempts: 2,
    generateImage: async (retryViolations, attempt) => {
      const model = attempt === 1
        ? config.primaryImageModel
        : config.fallbackImageModel;
      const prompt = buildImagePrompt({
        recipe,
        approvedPhotoIngredients: detectedIngredients,
        pantrySeasoningsUsed,
        confirmedIngredientDetails,
        finalPresentation,
        retryViolations,
      });
      const startedAt = Date.now();
      const response = await callOpenRouterChat(
        {
          model,
          messages: [{ role: "user", content: prompt }],
          modalities: ["image"],
          image_config: {
            aspect_ratio: "1:1",
          },
        },
        {
          stage: "image generation",
          attempt,
        }
      );
      const imageDataURL = extractImageDataURL(response);
      if (!imageDataURL) {
        throw new Error("OpenRouter image response did not include an image");
      }
      const reportedCostUSD = openRouterUsageCost(response);
      return {
        imageDataURL,
        metadata: {
          model,
          durationMs: Date.now() - startedAt,
          reportedCostUSD,
          estimatedCostUSD:
            reportedCostUSD === null ? estimatedImageCostUSD(model) : null,
          generationID: cleanString(response.id) || null,
        },
      };
    },
    validateImage: (imageDataURL) =>
      validateGeneratedImage(
        imageDataURL,
        detectedIngredients,
        pantrySeasoningsUsed,
        confirmedIngredientDetails,
        finalPresentation
      ),
  });
  const telemetry = summarizeImageGeneration(result.records);

  console.log("CookLens image generation", {
    dishName,
    success: Boolean(result.imageDataURL),
    attempts: result.attempts,
    ...telemetry,
  });

  return {
    imageDataURL: result.imageDataURL,
    imageError: result.imageError,
    attempts: result.attempts,
    source: {
      imageModel: result.records.at(-1)?.model || config.primaryImageModel,
      primaryImageModel: config.primaryImageModel,
      fallbackImageModel: config.fallbackImageModel,
      reviewModel: config.reviewModel,
      secondOpinionModel: config.secondOpinionModel,
      modelsUsed: result.records.map((record) => record.model).filter(Boolean),
      generationAttempts: result.records,
      ...telemetry,
    },
  };
}

async function validateGeneratedImage(
  imageDataURL,
  approvedPhotoIngredients,
  pantrySeasoningsUsed,
  confirmedIngredientDetails,
  finalPresentation
) {
  const prompt = [
    "Inspect the generated food image for CookLens ingredient compliance.",
    `Allowed photo ingredients: ${approvedPhotoIngredients.join(", ")}`,
    `Confirmed ingredient details: ${JSON.stringify(confirmedIngredientDetails)}`,
    `Allowed pantry seasonings incorporated into the food: ${pantrySeasoningsUsed.length ? pantrySeasoningsUsed.join(", ") : "none"}`,
    `Required final presentation: ${finalPresentation || "the approved food in its confirmed form"}`,
    "",
    "Ignore only the plain plate or bowl and neutral non-food background.",
    "Soup liquid, glaze, broth, sauce, oil, browning, char, and shine are allowed when they can be explained by water plus the approved pantry seasonings.",
    "Do not infer vegetables, herbs, grains, or other food from color, liquid texture, seasoning specks, or sauce thickness alone.",
    "Garnish, herbs, vegetables, grains, sides, extra protein, and background food count as visible food only when they are distinct visible objects.",
    "A cooked, reheated, sliced, or sauced form of an allowed ingredient is valid.",
    "Also check that the visible cut, whole/portion form, quantity, and finished state match the confirmed details and required presentation.",
    "Fail only when you can name a concrete visible unapproved food item or a concrete form/state mismatch.",
    "Use decision='uncertain' if the image is ambiguous or you cannot point to a concrete violation.",
    "Do not use generic phrases such as 'unapproved food' without naming the visible object.",
    "",
    `Return JSON only:
{
  "decision": "pass | fail | uncertain",
  "confidence": 0.0,
  "visibleFoodItems": ["string"],
  "unapprovedFoodItems": ["string"],
  "presentationIssues": ["specific mismatch"],
  "reason": "short explanation"
}`,
  ].join("\n");

  const primaryReview = await reviewGeneratedImage({
    model: config.reviewModel,
    systemContent:
      "You are a precise visual food compliance inspector. Reject only concrete visible violations and return valid JSON.",
    prompt,
    imageDataURL,
  });

  if (primaryReview.decision !== "uncertain") {
    return primaryReview;
  }

  const secondOpinionPrompt = [
    prompt,
    "",
    "The first reviewer was uncertain.",
    "Give an independent second opinion.",
    "If you cannot identify a concrete visible unapproved food item or concrete form/state mismatch, choose decision='pass'.",
  ].join("\n");
  const secondOpinion = await reviewGeneratedImage({
    model: config.secondOpinionModel,
    systemContent:
      "You are an independent second-opinion visual reviewer. Pass images unless a concrete visible violation is identifiable.",
    prompt: secondOpinionPrompt,
    imageDataURL,
  });

  return combineImageReviews(primaryReview, secondOpinion);
}

async function reviewGeneratedImage({
  model,
  systemContent,
  prompt,
  imageDataURL,
}) {
  const parsed = await callOpenRouterStructured({
    stage: "image review",
    model,
    messages: [
      {
        role: "system",
        content: systemContent,
      },
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          {
            type: "image_url",
            image_url: { url: imageDataURL },
          },
        ],
      },
    ],
    response_format: { type: "json_object" },
    temperature: 0,
    max_tokens: 500,
  });
  return normalizeImageReview(parsed, model);
}

async function callOpenRouterChat(payload, telemetry = {}) {
  const startedAt = Date.now();
  const requestID = currentRequestID();

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "http://localhost:8787",
        "X-Title": "CookLens MVP",
      },
      body: JSON.stringify({
        stream: false,
        ...payload,
      }),
    });

    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw httpError(response.status || 500, `OpenRouter returned non-JSON response: ${text.slice(0, 200)}`);
    }

    if (!response.ok) {
      throw httpError(response.status, openRouterErrorMessage(json));
    }

    console.log("CookLens OpenRouter request", {
      requestID,
      stage: telemetry.stage || "chat",
      attempt: telemetry.attempt || 1,
      model: payload.model,
      durationMs: Date.now() - startedAt,
      finishReason:
        json.choices?.[0]?.finish_reason
        || json.choices?.[0]?.native_finish_reason
        || null,
      reportedCostUSD: openRouterUsageCost(json),
    });
    return json;
  } catch (error) {
    console.error("CookLens OpenRouter request failed", {
      requestID,
      stage: telemetry.stage || "chat",
      attempt: telemetry.attempt || 1,
      model: payload.model,
      durationMs: Date.now() - startedAt,
      message: error.message || String(error),
    });
    throw error;
  }
}

async function callOpenRouterStructured({
  stage,
  maxAttempts = 2,
  ...payload
}) {
  const requestedMaxTokens = Number(payload.max_tokens) || 800;
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const maxTokens = attempt === 1
      ? Math.max(requestedMaxTokens, 1000)
      : Math.max(requestedMaxTokens * 2, 1800);
    const response = await callOpenRouterChat(
      {
        ...payload,
        max_tokens: maxTokens,
        reasoning: {
          max_tokens: attempt === 1 ? 160 : 96,
        },
        plugins: [
          ...(Array.isArray(payload.plugins) ? payload.plugins : []),
          { id: "response-healing" },
        ],
      },
      { stage, attempt }
    );

    try {
      return parseJSONFromOpenRouter(response, stage);
    } catch (error) {
      lastError = error;
      const choice = response.choices?.[0];
      console.warn(`CookLens ${stage} returned invalid structured data`, {
        attempt,
        finishReason: choice?.finish_reason || choice?.native_finish_reason || null,
        contentPreview: openRouterContentText(choice?.message?.content).slice(0, 240),
        message: error.message,
      });
    }
  }

  throw httpError(
    502,
    `CookLens received an incomplete ${stage} response. Please try again.`,
    "structured_response_invalid",
    { stage, reason: lastError?.message || "Invalid JSON" }
  );
}

function openRouterErrorMessage(json) {
  const directMessage = json.error?.message || json.message || "OpenRouter request failed";
  const rawMessage = json.error?.metadata?.raw;

  if (typeof rawMessage === "string" && rawMessage.trim()) {
    try {
      const parsed = JSON.parse(rawMessage);
      const providerMessage = parsed.error?.message;
      if (providerMessage) {
        return `${directMessage}: ${providerMessage}`;
      }
    } catch {
      return `${directMessage}: ${rawMessage.slice(0, 240)}`;
    }
  }

  return directMessage;
}

function parseJSONFromOpenRouter(response, stage = "AI") {
  const message = response.choices?.[0]?.message;
  const finishReason =
    response.choices?.[0]?.finish_reason
    || response.choices?.[0]?.native_finish_reason;
  const text = openRouterContentText(message?.content);

  const cleaned = text
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "");

  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1));
    }
    const suffix = finishReason === "length" || finishReason === "MAX_TOKENS"
      ? " because the response was cut off"
      : "";
    throw new Error(`Could not parse ${stage} JSON${suffix}`);
  }
}

function openRouterContentText(content) {
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        return part?.text || part?.content || part?.json || "";
      })
      .map((part) => typeof part === "string" ? part : JSON.stringify(part))
      .join("\n");
  }

  if (content && typeof content === "object") {
    return JSON.stringify(content);
  }

  return String(content || "");
}

function normalizeRecipeResponse(parsed, pantrySeasonings, notes) {
  const sourceRecipes = Array.isArray(parsed.recipes) ? parsed.recipes.slice(0, 2) : [];
  if (sourceRecipes.length !== 2) {
    throw new Error("Recipe response must contain exactly two recipes");
  }

  return sourceRecipes.map((recipe, index) => {
    const dishName = cleanString(recipe.dishName) || `Recipe Option ${index + 1}`;
    const detectedIngredients = normalizeStringArray(recipe.detectedIngredients).slice(0, 8);
    const pantrySeasoningsUsed = normalizeStringArray(recipe.pantrySeasoningsUsed).slice(0, 8);
    const steps = normalizeStringArray(recipe.steps).slice(0, 8);

    return {
      dishName,
      detectedIngredients,
      pantrySeasoningsUsed,
      cookingTime: cleanString(recipe.cookingTime) || "15 min",
      steps: steps.length ? steps : ["Cook the ingredients together until done, then season to taste."],
      finalPresentation: cleanString(recipe.finalPresentation)
        || `${dishName} showing only the approved food.`,
      pairingSuggestion: cleanString(recipe.pairingSuggestion) || null,
      notes: notes || null,
    };
  });
}

function normalizeDetectedIngredients(value) {
  if (!Array.isArray(value)) return [];

  const seen = new Set();
  const result = [];

  for (const ingredient of value) {
    const name = cleanString(ingredient?.name);
    const normalizedName = name.toLowerCase().replace(/\s+/g, " ");
    if (!name || seen.has(normalizedName)) continue;

    const numericConfidence = Number(ingredient?.confidence);
    const confidence = Number.isFinite(numericConfidence)
      ? Math.min(1, Math.max(0, numericConfidence))
      : 0;

    seen.add(normalizedName);
    const rawState = cleanString(ingredient?.state).toLowerCase();
    const state = ["raw", "cooked"].includes(rawState) ? rawState : "unknown";
    result.push({
      name,
      confidence,
      state,
      form: cleanString(ingredient?.form) || null,
      quantity: cleanString(ingredient?.quantity) || null,
    });
  }

  return result.slice(0, 10);
}

function estimatedImageCostUSD(model) {
  if (model === "black-forest-labs/flux.2-klein-4b") return 0.017;
  if (model === "bytedance-seed/seedream-4.5") return 0.04;
  return null;
}

function summarizeImageGeneration(records) {
  const reportedCosts = records
    .map((record) => record.reportedCostUSD)
    .filter((cost) => Number.isFinite(cost));
  const estimatedCosts = records
    .map((record) => record.reportedCostUSD ?? record.estimatedCostUSD)
    .filter((cost) => Number.isFinite(cost));

  return {
    reportedCostUSD:
      reportedCosts.length === records.length
        ? roundUSD(reportedCosts.reduce((total, cost) => total + cost, 0))
        : null,
    estimatedCostUSD:
      reportedCosts.length !== records.length && estimatedCosts.length
        ? roundUSD(estimatedCosts.reduce((total, cost) => total + cost, 0))
        : null,
    totalDurationMs: records.reduce(
      (total, record) => total + (Number(record.durationMs) || 0),
      0
    ),
  };
}

function roundUSD(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function requiredString(value, fieldName) {
  if (typeof value !== "string" || !value.trim()) {
    throw httpError(400, `${fieldName} is required`);
  }
  return value.trim();
}
