import json
from backend.database import SessionLocal, engine, Base, auto_create_all, describe_target
from backend.models.domain import User, Profile

# Schema belongs to Alembic. On a local database with DB_AUTO_CREATE=true this
# still creates missing tables first, as it always did; against the shared
# development database it does nothing and expects 'alembic upgrade head' to
# have run. Seeding itself is unchanged and still refuses to run twice.
auto_create_all()

def seed():
    print(f"Seeding {describe_target()}")
    db = SessionLocal()
    if db.query(Profile).first():
        print("Database already seeded")
        db.close()
        return

    # Seed data mimicking TWIN_DATA from frontend
    individual = Profile(
        key="individual",
        label="Individual",
        persona="Aarav Sharma · Salaried, Bengaluru",
        currency="₹",
        metrics=[
            {"id": "income", "label": "Monthly income", "value": 85000, "unit": "/mo", "trend": [78000,79500,81000,82000,83500,85000], "isPercent": False},
            {"id": "expenses", "label": "Monthly expenses", "value": 52000, "unit": "/mo", "trend": [49000,50000,53000,51000,54000,52000], "isPercent": False},
            {"id": "savings", "label": "Total savings", "value": 320000, "unit": "", "trend": [210000,240000,258000,281000,302000,320000], "isPercent": False},
            {"id": "goal", "label": "Goal progress", "value": 40, "unit": "%", "trend": [18,22,27,31,36,40], "isPercent": True}
        ],
        goal={"title": "Car fund: ₹8,00,000 by Dec 2027", "progress": 40, "target": 800000},
        decisionTypes=[
            {
                "id": "prepay_loan", "label": "Prepay personal loan",
                "primaryLabel": "Emergency buffer", "primaryUnit": " mo", "primaryStart": 4.2,
                "impactRate": -0.021, "goodDirection": "up",
                "secondaryLabel": "Interest saved (est.)", "secondaryUnit": "", "secondaryStart": 0, "secondaryImpactRate": 380,
                "inactionNote": "Buffer stays thin; interest keeps accruing on the outstanding balance."
            },
            {
                "id": "increase_sip", "label": "Increase monthly SIP",
                "primaryLabel": "Goal completion", "primaryUnit": "%", "primaryStart": 40,
                "impactRate": 0.18, "goodDirection": "up",
                "secondaryLabel": "Free cash flow left", "secondaryUnit": "", "secondaryStart": 33000, "secondaryImpactRate": -180,
                "inactionNote": "Goal stays on the current 17-month timeline."
            },
            {
                "id": "car_lease", "label": "Buy vs. lease a car",
                "primaryLabel": "Monthly cash flow", "primaryUnit": "", "primaryStart": 33000,
                "impactRate": -145, "goodDirection": "up",
                "secondaryLabel": "Buffer months", "secondaryUnit": " mo", "secondaryStart": 4.2, "secondaryImpactRate": -0.012,
                "inactionNote": "Cash flow position is preserved; the car purchase is deferred."
            }
        ]
    )
    
    startup = Profile(
        key="startup",
        label="Startup",
        persona="Loopwise Analytics · Seed stage, 34 employees",
        currency="₹",
        metrics=[
            {"id": "revenue", "label": "Monthly revenue", "value": 1800000, "unit": "/mo", "trend": [1100000,1250000,1400000,1550000,1680000,1800000], "isPercent": False},
            {"id": "burn", "label": "Monthly burn", "value": 2200000, "unit": "/mo", "trend": [1900000,2000000,2050000,2100000,2150000,2200000], "isPercent": False},
            {"id": "runway", "label": "Runway", "value": 9.4, "unit": " mo", "trend": [13.1,12.0,11.0,10.3,9.8,9.4], "isPercent": False},
            {"id": "headcount", "label": "Headcount", "value": 34, "unit": "", "trend": [26,28,29,31,32,34], "isPercent": False}
        ],
        goal={"title": "Reach ₹25L MRR before Series A conversations", "progress": 62, "target": 2500000},
        decisionTypes=[
            {
                "id": "prepay_loan", "label": "Prepay term loan",
                "primaryLabel": "Runway", "primaryUnit": " mo", "primaryStart": 9.4,
                "impactRate": -0.038, "goodDirection": "up",
                "secondaryLabel": "Interest saved (annualised)", "secondaryUnit": "", "secondaryStart": 0, "secondaryImpactRate": 4200,
                "inactionNote": "Loan interest keeps accruing; runway unaffected."
            },
            {
                "id": "hire_engineers", "label": "Hire 5 engineers",
                "primaryLabel": "Runway", "primaryUnit": " mo", "primaryStart": 9.4,
                "impactRate": -0.046, "goodDirection": "up",
                "secondaryLabel": "Shipping velocity (est.)", "secondaryUnit": "%", "secondaryStart": 100, "secondaryImpactRate": 0.55,
                "inactionNote": "Velocity stays flat; runway is preserved at 9.4 months."
            },
            {
                "id": "bridge_vs_extend", "label": "Raise bridge vs. extend runway",
                "primaryLabel": "Runway", "primaryUnit": " mo", "primaryStart": 9.4,
                "impactRate": 0.062, "goodDirection": "up",
                "secondaryLabel": "Dilution (est.)", "secondaryUnit": "%", "secondaryStart": 0, "secondaryImpactRate": 0.09,
                "inactionNote": "No new capital raised; current runway trajectory continues unchanged."
            }
        ]
    )



    db.add_all([individual, startup])
    db.commit()

    # We also need to add alerts and history for these profiles
    from backend.models.domain import Alert, DecisionHistory

    db.add_all([
        Alert(profile_id=individual.id, level="warn", text="Credit utilisation is above 40%, above the recommended threshold."),
        Alert(profile_id=individual.id, level="info", text="Emergency buffer covers 4.2 months of expenses, below the 6-month target."),
        DecisionHistory(profile_id=individual.id, title="Increased SIP by ₹5,000/mo", date_str="18 May 2026", outcome="Goal timeline improved by 3 months", tag="good"),
        DecisionHistory(profile_id=individual.id, title="Used credit card for travel booking", date_str="02 May 2026", outcome="Utilisation crossed 40% threshold", tag="warn"),
        DecisionHistory(profile_id=individual.id, title="Moved ₹40,000 to fixed deposit", date_str="14 Apr 2026", outcome="Buffer stability improved", tag="good"),
        
        Alert(profile_id=startup.id, level="warn", text="Runway falls under 6 months if the planned hiring round proceeds at full pace."),
        Alert(profile_id=startup.id, level="info", text="Burn multiple (burn ÷ net new revenue) is trending up for the second straight month."),
        DecisionHistory(profile_id=startup.id, title="Renegotiated AWS committed-use contract", date_str="22 May 2026", outcome="Burn reduced by ₹1.4L/mo", tag="good"),
        DecisionHistory(profile_id=startup.id, title="Extended two contractor offers", date_str="09 May 2026", outcome="Runway shortened by 0.6 months", tag="warn"),
        DecisionHistory(profile_id=startup.id, title="Closed ₹40L bridge note", date_str="30 Apr 2026", outcome="Runway extended by 2.1 months", tag="good"),

    ])
    db.commit()
    print("Database seeded with sample profiles.")
    db.close()

if __name__ == "__main__":
    seed()
