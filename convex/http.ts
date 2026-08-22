import { httpRouter } from "convex/server";
import { WebhookEvent } from "@clerk/nextjs/server";
import { Webhook } from "svix";
import { api } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { GoogleGenerativeAI } from "@google/generative-ai";


const http = httpRouter();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

http.route({
  path: "/clerk-webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const webhookSecret = process.env.CLERK_WEBHOOK_SECRET;
    if (!webhookSecret) {
      throw new Error("Missing CLERK_WEBHOOK_SECRET environment variable");
    }

    const svix_id = request.headers.get("svix-id");
    const svix_signature = request.headers.get("svix-signature");
    const svix_timestamp = request.headers.get("svix-timestamp");

    if (!svix_id || !svix_signature || !svix_timestamp) {
      return new Response("No svix headers found", {
        status: 400,
      });
    }

    const payload = await request.json();
    const body = JSON.stringify(payload);

    const wh = new Webhook(webhookSecret);
    let evt: WebhookEvent;

    try {
      evt = wh.verify(body, {
        "svix-id": svix_id,
        "svix-timestamp": svix_timestamp,
        "svix-signature": svix_signature,
      }) as WebhookEvent;
    } catch (err) {
      console.error("Error verifying webhook:", err);
      return new Response("Error occurred", { status: 400 });
    }

    const eventType = evt.type;

    if (eventType === "user.created") {
      const { id, first_name, last_name, image_url, email_addresses } = evt.data;

      const email = email_addresses[0].email_address;

      const name = `${first_name || ""} ${last_name || ""}`.trim();

      try {
        await ctx.runMutation(api.users.syncUser, {
          email,
          name,
          image: image_url,
          clerkId: id,
        });
      } catch (error) {
        console.log("Error creating user:", error);
        return new Response("Error creating user", { status: 500 });
      }
    }
    return new Response("Webhooks processed successfully", { status: 200 });
  }),
});

function extractVapiPayload(payload: any) {
  let args: any = {};
  let toolCallId: string | undefined = undefined;

  // 1. Vapi tool-calls structure (message.toolCalls)
  if (payload?.message?.toolCalls?.[0]?.function) {
    const fn = payload.message.toolCalls[0].function;
    toolCallId = payload.message.toolCalls[0].id;
    const rawArgs = fn.arguments;
    if (typeof rawArgs === "string") {
      try {
        args = JSON.parse(rawArgs);
      } catch (e) {
        console.error("Failed to parse toolCalls arguments JSON string:", e);
      }
    } else if (typeof rawArgs === "object" && rawArgs !== null) {
      args = rawArgs;
    }
  }
  // 2. Vapi functionCall structure (message.functionCall)
  else if (payload?.message?.functionCall) {
    const fn = payload.message.functionCall;
    const rawArgs = fn.parameters || fn.arguments;
    if (typeof rawArgs === "string") {
      try {
        args = JSON.parse(rawArgs);
      } catch (e) {
        console.error("Failed to parse functionCall arguments JSON string:", e);
      }
    } else if (typeof rawArgs === "object" && rawArgs !== null) {
      args = rawArgs;
    }
  }
  // 3. Vapi toolCall structure (toolCall.function)
  else if (payload?.toolCall?.function) {
    const fn = payload.toolCall.function;
    toolCallId = payload.toolCall.id;
    const rawArgs = fn.arguments;
    if (typeof rawArgs === "string") {
      try {
        args = JSON.parse(rawArgs);
      } catch (e) {}
    } else if (typeof rawArgs === "object" && rawArgs !== null) {
      args = rawArgs;
    }
  }
  // 4. Direct flat structure
  else {
    args = payload || {};
  }

  // Extract user_id with fallbacks to Vapi call variableValues
  const userId =
    args.user_id ||
    args.userId ||
    payload?.message?.call?.variableValues?.user_id ||
    payload?.call?.variableValues?.user_id ||
    payload?.variableValues?.user_id;

  return {
    toolCallId,
    user_id: userId,
    age: args.age || args.Age || "25",
    height: args.height || args.Height || "170 cm",
    weight: args.weight || args.Weight || "70 kg",
    injuries: args.injuries || args.Injuries || "None",
    workout_days: args.workout_days || args.workoutDays || args.days || "3",
    fitness_goal: args.fitness_goal || args.fitnessGoal || args.goal || "General Fitness",
    fitness_level: args.fitness_level || args.fitnessLevel || args.level || "Beginner",
    dietary_restrictions: args.dietary_restrictions || args.dietaryRestrictions || args.diet || "None",
  };
}

function parseGeminiJson(text: string) {
  const cleaned = text
    .replace(/```(?:json)?/gi, "")
    .replace(/```/g, "")
    .trim();
  return JSON.parse(cleaned);
}

function validateWorkoutPlan(plan: any) {
  if (!plan || typeof plan !== "object") {
    plan = {};
  }

  const schedule = Array.isArray(plan.schedule)
    ? plan.schedule.map(String)
    : ["Monday", "Wednesday", "Friday"];

  const rawExercises = Array.isArray(plan.exercises) ? plan.exercises : [];
  const exercises = rawExercises.map((exercise: any) => ({
    day: String(exercise.day || "Day 1"),
    routines: (Array.isArray(exercise.routines) ? exercise.routines : []).map((routine: any) => {
      const rawSets =
        typeof routine.sets === "number" && !isNaN(routine.sets)
          ? routine.sets
          : parseInt(routine.sets);
      const sets = !isNaN(rawSets) && rawSets > 0 ? rawSets : 3;

      const rawReps =
        typeof routine.reps === "number" && !isNaN(routine.reps)
          ? routine.reps
          : parseInt(routine.reps);
      const reps = !isNaN(rawReps) && rawReps > 0 ? rawReps : 10;

      return {
        name: String(routine.name || "Exercise"),
        sets,
        reps,
      };
    }),
  }));

  return { schedule, exercises };
}

// validate diet plan to ensure it strictly follows schema
function validateDietPlan(plan: any) {
  if (!plan || typeof plan !== "object") {
    plan = {};
  }

  let dailyCalories = 2000;
  if (typeof plan.dailyCalories === "number" && !isNaN(plan.dailyCalories)) {
    dailyCalories = plan.dailyCalories;
  } else if (plan.dailyCalories) {
    const parsed = parseInt(String(plan.dailyCalories).replace(/[^0-9]/g, ""));
    if (!isNaN(parsed) && parsed > 0) {
      dailyCalories = parsed;
    }
  }

  const rawMeals = Array.isArray(plan.meals) ? plan.meals : [];
  const meals = rawMeals.map((meal: any) => ({
    name: String(meal.name || "Meal"),
    foods: Array.isArray(meal.foods)
      ? meal.foods.map(String)
      : typeof meal.foods === "string"
      ? [meal.foods]
      : ["Healthy food option"],
  }));

  return { dailyCalories, meals };
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

http.route({
  path: "/vapi/generate-program",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    });
  }),
});

http.route({
  path: "/vapi/generate-program",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const rawPayload = await request.json();
      console.log("Raw payload received from Vapi:", JSON.stringify(rawPayload));

      const {
        toolCallId,
        user_id,
        age,
        height,
        weight,
        injuries,
        workout_days,
        fitness_goal,
        fitness_level,
        dietary_restrictions,
      } = extractVapiPayload(rawPayload);

      console.log("Extracted params:", {
        user_id,
        age,
        height,
        weight,
        injuries,
        workout_days,
        fitness_goal,
        fitness_level,
        dietary_restrictions,
      });

      let activeUserId = user_id;
      if (!activeUserId) {
        const latestUser = await ctx.runMutation(api.users.getLatestUser, {});
        if (latestUser?.clerkId) {
          activeUserId = latestUser.clerkId;
        } else {
          activeUserId = "default_user";
        }
      }

      const model = genAI.getGenerativeModel({
        model: "gemini-3.6-flash",
        generationConfig: {
          temperature: 0.4, // lower temperature for more predictable outputs
          topP: 0.9,
          responseMimeType: "application/json",
        },
      });

      const workoutPrompt = `You are an experienced fitness coach creating a personalized workout plan based on:
      Age: ${age}
      Height: ${height}
      Weight: ${weight}
      Injuries or limitations: ${injuries}
      Available days for workout: ${workout_days}
      Fitness goal: ${fitness_goal}
      Fitness level: ${fitness_level}
      
      As a professional coach:
      - Consider muscle group splits to avoid overtraining the same muscles on consecutive days
      - Design exercises that match the fitness level and account for any injuries
      - Structure the workouts to specifically target the user's fitness goal
      
      CRITICAL SCHEMA INSTRUCTIONS:
      - Your output MUST contain ONLY the fields specified below, NO ADDITIONAL FIELDS
      - "sets" and "reps" MUST ALWAYS be NUMBERS, never strings
      - For example: "sets": 3, "reps": 10
      - Do NOT use text like "reps": "As many as possible" or "reps": "To failure"
      - Instead use specific numbers like "reps": 12 or "reps": 15
      - For cardio, use "sets": 1, "reps": 1 or another appropriate number
      - NEVER include strings for numerical fields
      - NEVER add extra fields not shown in the example below
      
      Return a JSON object with this EXACT structure:
      {
        "schedule": ["Monday", "Wednesday", "Friday"],
        "exercises": [
          {
            "day": "Monday",
            "routines": [
              {
                "name": "Exercise Name",
                "sets": 3,
                "reps": 10
              }
            ]
          }
        ]
      }
      
      DO NOT add any fields that are not in this example. Your response must be a valid JSON object with no additional text.`;

      const dietPrompt = `You are an experienced nutrition coach creating a personalized diet plan based on:
        Age: ${age}
        Height: ${height}
        Weight: ${weight}
        Fitness goal: ${fitness_goal}
        Dietary restrictions: ${dietary_restrictions}
        
        As a professional nutrition coach:
        - Calculate appropriate daily calorie intake based on the person's stats and goals
        - Create a balanced meal plan with proper macronutrient distribution
        - Include a variety of nutrient-dense foods while respecting dietary restrictions
        - Consider meal timing around workouts for optimal performance and recovery
        
        CRITICAL SCHEMA INSTRUCTIONS:
        - Your output MUST contain ONLY the fields specified below, NO ADDITIONAL FIELDS
        - "dailyCalories" MUST be a NUMBER, not a string
        - DO NOT add fields like "supplements", "macros", "notes", or ANYTHING else
        - ONLY include the EXACT fields shown in the example below
        - Each meal should include ONLY a "name" and "foods" array

        Return a JSON object with this EXACT structure and no other fields:
        {
          "dailyCalories": 2000,
          "meals": [
            {
              "name": "Breakfast",
              "foods": ["Oatmeal with berries", "Greek yogurt", "Black coffee"]
            },
            {
              "name": "Lunch",
              "foods": ["Grilled chicken salad", "Whole grain bread", "Water"]
            }
          ]
        }
        
        DO NOT add any fields that are not in this example. Your response must be a valid JSON object with no additional text.`;

      // Run both Gemini generation calls in parallel for fast response times (< 5s)
      const [workoutResult, dietResult] = await Promise.all([
        model.generateContent(workoutPrompt),
        model.generateContent(dietPrompt),
      ]);

      const workoutPlanText = workoutResult.response.text();
      let workoutPlan = parseGeminiJson(workoutPlanText);
      workoutPlan = validateWorkoutPlan(workoutPlan);

      const dietPlanText = dietResult.response.text();
      let dietPlan = parseGeminiJson(dietPlanText);
      dietPlan = validateDietPlan(dietPlan);

      // save to our DB: CONVEX
      const planId = await ctx.runMutation(api.plans.createPlan, {
        userId: activeUserId,
        dietPlan,
        isActive: true,
        workoutPlan,
        name: `${fitness_goal} Plan - ${new Date().toLocaleDateString()}`,
      });

      const responseBody: any = {
        success: true,
        data: {
          planId,
          workoutPlan,
          dietPlan,
        },
      };

      if (toolCallId) {
        responseBody.results = [
          {
            toolCallId,
            result: "Workout and diet plan generated successfully!",
          },
        ];
      }

      return new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    } catch (error) {
      console.error("Error generating fitness plan:", error);
      return new Response(
        JSON.stringify({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        }
      );
    }
  }),
});

export default http;