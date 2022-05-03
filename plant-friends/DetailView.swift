//
//  SwiftUIView.swift
//  plant-friends
//
//  Created by Saul Shanabrook on 5/2/22.
//

import SwiftUI

struct DetailView: View {
    var plant: PFAFPlant
    
    var body: some View {
        VStack(alignment: .leading) {
            Text(plant.latin_name)
                .font(.title)

            HStack {
                Text(plant.common_names.joined(separator: ", "))
            }
            .font(.subheadline)
            .foregroundColor(.secondary)

            Divider()

            Text("Habit")
                .font(.title2)
            Text(plant.habit)
        }
        .padding()

    }
}

struct DetailView_Previews: PreviewProvider {
    static var previews: some View {
        DetailView(plant: PFAFPlant.sample)
    }
}
