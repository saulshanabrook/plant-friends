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
        ScrollView{
            VStack(alignment: .leading) {
                Text(plant.latin_name)
                    .font(.title)
                
                Text(plant.common_names_joined)
                    .font(.subheadline)
                    .foregroundColor(.secondary)
                
                Divider()
                Text("Edible Uses")
                    .font(.title2)
                Text(plant.edible_uses)
                    .font(.body)
                Text("Medicinal Uses")
                    .font(.title2)
                Text(plant.medicinal_uses)
            }
            .padding()
            
        }
    }
}

struct DetailView_Previews: PreviewProvider {
    static var previews: some View {
        DetailView(plant: PFAFPlant.sample)
    }
}
