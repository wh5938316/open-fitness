#if DEBUG
  import Foundation
  import OpenFitnessKit

  enum PreviewExerciseCatalog {
    static let records: [Record<Exercise>] = {
      let json = #"""
        [
          {"id":"cat-preview-bench","kind":"exercise","version":0,
           "createdAt":"2026-10-21T00:00:00Z","updatedAt":"2026-10-21T00:00:00Z",
           "data":{"name":"Barbell bench press","aliases":["Bench press"],"category":"strength",
             "description":null,"instructions":"1. Set up on the bench.\n2. Press with control.",
             "bodyPart":"chest","equipment":["barbell"],"primaryMuscles":["pectorals"],
             "secondaryMuscles":["triceps"],"movementCategory":"strength",
             "source":{"kind":"catalog","attribution":"OpenFitness test fixture","license":"MIT"},
             "i18n":{"zh-CN":{"name":"杠铃卧推","aliases":["卧推"],"description":"练习胸部肌群。",
               "instructions":"1. 在卧推凳上躺稳。\n2. 平稳推起杠铃。","provenance":{"method":"human","reviewed":true}}},
             "diagram":{"gender":"male","views":["front"],"highlights":[
               {"region":"chest","role":"primary","surfaces":["CHEST_LEFT","CHEST_RIGHT"],"groups":["CHEST"],"matched":true},
               {"region":"triceps","role":"secondary","surfaces":["TRICEPS_LEFT","TRICEPS_RIGHT"],"groups":["TRICEPS"],"matched":true}]}}},
          {"id":"cat-preview-rewrite","kind":"exercise","version":0,
           "createdAt":"2026-10-21T00:00:00Z","updatedAt":"2026-10-21T00:00:00Z",
           "data":{"name":"Bench mobility","category":"duration","description":null,"instructions":"",
             "needsRewrite":true,"bodyPart":"chest","equipment":["body weight"],
             "movementCategory":"mobility","source":{"kind":"catalog"},
             "i18n":{"zh-CN":{"name":"卧推活动度练习","provenance":{"method":"human","reviewed":false}}}}}
        ]
        """#
      return (try? JSONDecoder().decode([Record<Exercise>].self, from: Data(json.utf8))) ?? []
    }()

    static let taxonomy: ExerciseTaxonomy = {
      let json = #"""
        {"bodyParts":[{"id":"chest","label":"Chest"}],
         "equipment":[{"id":"barbell","label":"Barbell"},{"id":"body weight","label":"Body weight"}],
         "muscles":[{"id":"pectorals","label":"Pectorals"},{"id":"triceps","label":"Triceps"}],
         "movementCategories":[{"id":"strength","label":"Strength"},{"id":"mobility","label":"Mobility"}],
         "diagrams":{"artwork":"MuscleMap","viewBox":"0 0 1024 1536","packageVersion":"preview",
           "license":"MIT","assets":{}},"attribution":"OpenFitness test fixture"}
        """#
      // A malformed debug fixture must fail before it can mask a UI regression.
      return try! JSONDecoder().decode(ExerciseTaxonomy.self, from: Data(json.utf8))
    }()
  }
#endif
